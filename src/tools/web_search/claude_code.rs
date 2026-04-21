

use std::time::Instant;

use serde_json::{json, Value};

use crate::tools::ToolError;

const REQUEST_TIMEOUT_SECS: u64 = 60;

const WEB_SEARCH_MAX_USES: u64 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
}

impl SearchHit {
    fn to_json(&self) -> Value {
        json!({
            "title": self.title,
            "url": self.url,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResult {
    pub tool_use_id: String,
    pub content: Vec<SearchHit>,
}

impl SearchResult {
    fn to_json(&self) -> Value {
        json!({
            "tool_use_id": self.tool_use_id,
            "content": self.content.iter().map(SearchHit::to_json).collect::<Vec<_>>(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ResultEntry {
    Text(String),
    Result(SearchResult),
}

impl ResultEntry {
    fn to_json(&self) -> Value {
        match self {
            ResultEntry::Text(s) => Value::String(s.clone()),
            ResultEntry::Result(r) => r.to_json(),
        }
    }
}

trait WebSearchBackend {
    fn search(&self, query: &str) -> Result<Vec<ResultEntry>, ToolError>;
}

struct UnavailableBackend;

impl WebSearchBackend for UnavailableBackend {
    fn search(&self, _query: &str) -> Result<Vec<ResultEntry>, ToolError> {
        Ok(Vec::new())
    }
}

struct AnthropicServerToolBackend {
    allowed_domains: Vec<String>,
    blocked_domains: Vec<String>,
}

impl AnthropicServerToolBackend {

    fn from_auth(allowed_domains: Vec<String>, blocked_domains: Vec<String>) -> Option<Self> {
        match crate::auth::anthropic::load_credentials() {
            Ok(Some(_)) => Some(Self {
                allowed_domains,
                blocked_domains,
            }),
            _ => None,
        }
    }

    fn build_server_tool_config(&self) -> Value {
        let mut cfg = serde_json::Map::new();
        cfg.insert("type".into(), Value::String("web_search_20250305".into()));
        cfg.insert("name".into(), Value::String("web_search".into()));
        if !self.allowed_domains.is_empty() {
            cfg.insert(
                "allowed_domains".into(),
                Value::Array(
                    self.allowed_domains
                        .iter()
                        .map(|d| Value::String(d.clone()))
                        .collect(),
                ),
            );
        }
        if !self.blocked_domains.is_empty() {
            cfg.insert(
                "blocked_domains".into(),
                Value::Array(
                    self.blocked_domains
                        .iter()
                        .map(|d| Value::String(d.clone()))
                        .collect(),
                ),
            );
        }
        cfg.insert("max_uses".into(), Value::Number(WEB_SEARCH_MAX_USES.into()));
        Value::Object(cfg)
    }

    fn build_request_body(&self, query: &str) -> Vec<u8> {
        crate::translator::anthropic::request::build_web_search_body(
            query,
            self.build_server_tool_config(),
        )
    }
}

impl WebSearchBackend for AnthropicServerToolBackend {
    fn search(&self, query: &str) -> Result<Vec<ResultEntry>, ToolError> {
        let body = self.build_request_body(query);

        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async move {
                let bearer = crate::auth::anthropic::authorization_header()
                    .await
                    .map_err(|e| ToolError::InvalidArgs(format!("auth: {e}")))?;

                let client = crate::tools::http::default_client(REQUEST_TIMEOUT_SECS)?;

                let mut headers = crate::provider::anthropic::build_inference_headers(
                    &bearer,  false,
                )
                .map_err(|e| {
                    ToolError::InvalidArgs(format!("failed to build inference headers: {e}"))
                })?;
                headers.insert(
                    "anthropic-beta",
                    reqwest::header::HeaderValue::from_static(
                        crate::fingerprint::anthropic::ANTHROPIC_BETA_WEB_SEARCH,
                    ),
                );

                headers.insert(
                    reqwest::header::ACCEPT,
                    reqwest::header::HeaderValue::from_static("text/event-stream"),
                );

                let resp = client
                    .post(crate::fingerprint::anthropic::API_MESSAGES_URL)
                    .headers(headers)
                    .body(body)
                    .send()
                    .await
                    .map_err(|e| {
                        ToolError::InvalidArgs(format!("anthropic web_search fetch failed: {e}"))
                    })?;

                let status = resp.status();
                if !status.is_success() {
                    let body_text = resp.text().await.unwrap_or_default();
                    return Err(ToolError::InvalidArgs(format!(
                        "anthropic web_search returned http {}: {}",
                        status.as_u16(),
                        body_text
                    )));
                }

                let blocks = collect_sse_content_blocks(resp).await?;
                Ok(parse_server_tool_blocks(&blocks))
            })
        })
    }
}

async fn collect_sse_content_blocks(
    resp: reqwest::Response,
) -> Result<Vec<Value>, ToolError> {
    use futures::StreamExt;

    let mut blocks: Vec<Value> = Vec::new();
    let mut pending_input_json: std::collections::HashMap<usize, String> =
        std::collections::HashMap::new();
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| {
            ToolError::InvalidArgs(format!("web_search stream error: {e}"))
        })?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buf.find("\n\n") {
            let raw_event = buf[..pos].to_string();
            buf.drain(..pos + 2);

            let data_line = raw_event
                .lines()
                .find(|l| l.starts_with("data:"))
                .map(|l| l.trim_start_matches("data:").trim());
            let Some(data) = data_line else { continue };
            if data == "[DONE]" {
                break;
            }
            let parsed: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let ty = parsed.get("type").and_then(Value::as_str).unwrap_or("");
            match ty {
                "content_block_start" => {
                    let idx = parsed
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize;
                    let block = parsed
                        .get("content_block")
                        .cloned()
                        .unwrap_or(Value::Null);
                    while blocks.len() <= idx {
                        blocks.push(Value::Null);
                    }
                    blocks[idx] = block;
                }
                "content_block_delta" => {
                    let idx = parsed
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize;
                    let delta = match parsed.get("delta") {
                        Some(d) => d,
                        None => continue,
                    };
                    let dty = delta.get("type").and_then(Value::as_str).unwrap_or("");
                    if idx >= blocks.len() {
                        continue;
                    }
                    match dty {
                        "input_json_delta" => {

                            let partial = delta
                                .get("partial_json")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            pending_input_json
                                .entry(idx)
                                .or_default()
                                .push_str(partial);
                        }
                        "text_delta" => {
                            if let Some(block) = blocks[idx].as_object_mut() {
                                let existing = block
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let added = delta
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                block.insert(
                                    "text".to_string(),
                                    Value::String(format!("{existing}{added}")),
                                );
                            }
                        }
                        _ => {}

                    }
                }
                "content_block_stop" => {
                    let idx = parsed
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize;
                    if let Some(raw_json) = pending_input_json.remove(&idx) {
                        if !raw_json.is_empty() {
                            if let (Some(block), Ok(parsed_input)) = (
                                blocks.get_mut(idx).and_then(Value::as_object_mut),
                                serde_json::from_str::<Value>(&raw_json),
                            ) {
                                block.insert("input".to_string(), parsed_input);
                            }
                        }
                    }
                }
                "message_stop" => break,
                _ => {}
            }
        }
    }

    Ok(blocks)
}

fn parse_server_tool_blocks(blocks: &[Value]) -> Vec<ResultEntry> {
    let mut results: Vec<ResultEntry> = Vec::new();
    let mut text_acc = String::new();

    let mut in_text = true;

    for block in blocks {
        let Some(kind) = block.get("type").and_then(Value::as_str) else {
            continue;
        };

        match kind {
            "server_tool_use" => {
                if in_text {
                    in_text = false;
                    let trimmed = text_acc.trim();
                    if !trimmed.is_empty() {
                        results.push(ResultEntry::Text(trimmed.to_string()));
                    }
                    text_acc.clear();
                }

            }

            "web_search_tool_result" => {
                let tool_use_id = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();

                match block.get("content") {
                    Some(Value::Array(hits)) => {
                        let content: Vec<SearchHit> = hits
                            .iter()
                            .map(|hit| SearchHit {
                                title: hit
                                    .get("title")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                url: hit
                                    .get("url")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            })
                            .collect();
                        results.push(ResultEntry::Result(SearchResult {
                            tool_use_id,
                            content,
                        }));
                    }

                    Some(err) => {
                        let code = err
                            .get("error_code")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        results.push(ResultEntry::Text(format!("Web search error: {code}")));
                    }
                    None => {
                        results.push(ResultEntry::Text(
                            "Web search error: unknown".to_string(),
                        ));
                    }
                }
            }

            "text" => {
                let chunk = block.get("text").and_then(Value::as_str).unwrap_or("");
                if in_text {
                    text_acc.push_str(chunk);
                } else {
                    in_text = true;
                    text_acc = chunk.to_string();
                }
            }

            _ => {

            }
        }
    }

    if !text_acc.is_empty() {
        let trimmed = text_acc.trim();
        if !trimmed.is_empty() {
            results.push(ResultEntry::Text(trimmed.to_string()));
        }
    }

    results
}

fn parse_domain_list(args: &Value, field: &str) -> Result<Vec<String>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(xs)) => xs
            .iter()
            .map(|v| {
                v.as_str().map(str::to_string).ok_or_else(|| {
                    ToolError::InvalidArgs(format!("{field}[] must contain only strings"))
                })
            })
            .collect(),
        Some(_) => Err(ToolError::InvalidArgs(format!(
            "{field} must be an array of strings"
        ))),
    }
}

fn select_backend(
    allowed_domains: Vec<String>,
    blocked_domains: Vec<String>,
) -> Box<dyn WebSearchBackend> {
    if let Some(backend) =
        AnthropicServerToolBackend::from_auth(allowed_domains, blocked_domains)
    {
        Box::new(backend)
    } else {
        Box::new(UnavailableBackend)
    }
}

const UNAVAILABLE_MARKER: &str =
    "web_search_unavailable - requires anthropic-oauth credentials (run `otherside login`)";

pub fn web_search(args: &Value) -> Result<Value, ToolError> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("Error: Missing query".into()))?
        .to_string();
    if query.trim().is_empty() {
        return Err(ToolError::InvalidArgs("Error: Missing query".into()));
    }

    if query.chars().count() < 2 {
        return Err(ToolError::InvalidArgs(
            "Error: query must be at least 2 characters".into(),
        ));
    }

    let allowed = parse_domain_list(args, "allowed_domains")?;
    let blocked = parse_domain_list(args, "blocked_domains")?;
    if !allowed.is_empty() && !blocked.is_empty() {

        return Err(ToolError::InvalidArgs(
            "Error: Cannot specify both allowed_domains and blocked_domains in the same request"
                .into(),
        ));
    }

    let auth_present = crate::auth::anthropic::load_credentials()
        .map(|c| c.is_some())
        .unwrap_or(false);

    let backend = select_backend(allowed, blocked);
    let started = Instant::now();
    let entries = backend.search(&query)?;
    let duration_seconds = started.elapsed().as_secs_f64();

    let results_json: Vec<Value> = if !auth_present {

        vec![Value::String(UNAVAILABLE_MARKER.to_string())]
    } else {
        entries.iter().map(ResultEntry::to_json).collect()
    };

    let mut out = json!({
        "query": query,
        "results": results_json,
        "durationSeconds": duration_seconds,
    });

    const MAX_RESULT_SIZE_CHARS: usize = 100_000;
    let serialized_len = serde_json::to_string(&out["results"])
        .map(|s| s.len())
        .unwrap_or(0);
    if serialized_len > MAX_RESULT_SIZE_CHARS {
        out["results"] = Value::Array(vec![Value::String(format!(
            "web_search_result_truncated - payload exceeded {MAX_RESULT_SIZE_CHARS} chars"
        ))]);
    }
    Ok(out)
}

pub use crate::harness::TOOL_WEB_SEARCH_JSON;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_const_parses_as_json() {
        let v: Value = serde_json::from_str(TOOL_WEB_SEARCH_JSON).unwrap();
        assert_eq!(v["name"], "WebSearch");
        let required = v["input_schema"]["required"].as_array().unwrap();
        assert!(required.iter().any(|r| r == "query"));
    }

    #[test]
    fn schema_carries_domain_filter_properties() {
        let v: Value = serde_json::from_str(TOOL_WEB_SEARCH_JSON).unwrap();
        let props = v["input_schema"]["properties"].as_object().unwrap();
        assert!(props.contains_key("query"));
        assert!(props.contains_key("allowed_domains"));
        assert!(props.contains_key("blocked_domains"));
    }

    #[test]
    fn schema_description_mentions_anthropic_oauth_requirement() {

        let v: Value = serde_json::from_str(TOOL_WEB_SEARCH_JSON).unwrap();
        let desc = v["description"].as_str().unwrap();
        assert!(desc.contains("anthropic-oauth"), "actual: {desc}");
        assert!(
            desc.contains("web_search_20250305"),
            "schema description must name the server-tool so the model picks it correctly"
        );
    }

    #[test]
    fn web_search_rejects_missing_query() {
        let err = web_search(&json!({})).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("query")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_empty_query() {
        let err = web_search(&json!({"query": "   "})).unwrap_err();

        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("Missing query"), "actual: {msg}");
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_one_char_query() {

        let err = web_search(&json!({"query": "a"})).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("2 characters"), "actual: {msg}");
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_both_filter_lists() {
        let err = web_search(&json!({
            "query": "rust async",
            "allowed_domains": ["example.com"],
            "blocked_domains": ["spam.tld"],
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("both"));
                assert!(msg.contains("allowed_domains"));
                assert!(msg.contains("blocked_domains"));
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_non_array_filter_list() {
        let err = web_search(&json!({
            "query": "rust",
            "allowed_domains": "example.com",
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("allowed_domains")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_non_string_filter_entry() {
        let err = web_search(&json!({
            "query": "rust",
            "blocked_domains": [42],
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("blocked_domains")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    fn with_empty_config_dir<F: FnOnce()>(body: F) {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let saved = std::env::var_os("OTHERSIDE_CONFIG_DIR");
        let tmp = std::env::temp_dir().join(format!(
            "otherside-test-web-search-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("mkdir temp config dir");
        std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp);

        body();

        match saved {
            Some(v) => std::env::set_var("OTHERSIDE_CONFIG_DIR", v),
            None => std::env::remove_var("OTHERSIDE_CONFIG_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn unavailable_backend_when_no_auth() {
        with_empty_config_dir(|| {
            let out = web_search(&json!({"query": "rust ownership"})).unwrap();
            assert_eq!(out["query"], "rust ownership");
            let results = out["results"].as_array().unwrap();
            assert_eq!(results.len(), 1);
            let marker = results[0].as_str().unwrap();
            assert!(marker.starts_with("web_search_unavailable"));
            assert!(marker.contains("anthropic-oauth"));
            assert!(out["durationSeconds"].is_number());
        });
    }

    #[test]
    fn server_tool_config_has_required_fields() {
        let backend = AnthropicServerToolBackend {
            allowed_domains: vec![],
            blocked_domains: vec![],
        };
        let cfg = backend.build_server_tool_config();
        assert_eq!(cfg["type"], "web_search_20250305");
        assert_eq!(cfg["name"], "web_search");
        assert_eq!(cfg["max_uses"], 8);

        assert!(cfg.get("allowed_domains").is_none());
        assert!(cfg.get("blocked_domains").is_none());
    }

    #[test]
    fn server_tool_config_includes_allowed_domains_when_set() {
        let backend = AnthropicServerToolBackend {
            allowed_domains: vec!["wikipedia.org".into(), "rust-lang.org".into()],
            blocked_domains: vec![],
        };
        let cfg = backend.build_server_tool_config();
        let allowed = cfg["allowed_domains"].as_array().unwrap();
        assert_eq!(allowed.len(), 2);
        assert_eq!(allowed[0], "wikipedia.org");
    }

    #[test]
    fn server_tool_config_includes_blocked_domains_when_set() {
        let backend = AnthropicServerToolBackend {
            allowed_domains: vec![],
            blocked_domains: vec!["spam.tld".into()],
        };
        let cfg = backend.build_server_tool_config();
        let blocked = cfg["blocked_domains"].as_array().unwrap();
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0], "spam.tld");
    }

    #[test]
    fn request_body_embeds_query_in_user_message() {
        let backend = AnthropicServerToolBackend {
            allowed_domains: vec![],
            blocked_domains: vec![],
        };
        let body = backend.build_request_body("rust ownership");
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["model"], "claude-opus-4-7");

        assert_eq!(parsed["stream"], true);

        assert_eq!(parsed["max_tokens"], 64000);
        assert_eq!(parsed["thinking"]["type"], "adaptive");
        assert_eq!(parsed["output_config"]["effort"], "xhigh");
        assert!(parsed["metadata"]["user_id"].is_string());
        assert_eq!(parsed["system"].as_array().unwrap().len(), 3);

        let user_text = parsed["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(
            user_text.contains("rust ownership"),
            "user message must carry the query: {user_text}"
        );

        assert!(user_text.starts_with("Perform a web search for the query:"));

        let tools = parsed["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "web_search_20250305");
    }

    #[test]
    fn parse_blocks_handles_empty_content() {
        let out = parse_server_tool_blocks(&[]);
        assert!(out.is_empty());
    }

    #[test]
    fn parse_blocks_single_text_block_becomes_text_entry() {
        let blocks = vec![json!({"type": "text", "text": "Here is the answer"})];
        let out = parse_server_tool_blocks(&blocks);
        assert_eq!(out.len(), 1);
        match &out[0] {
            ResultEntry::Text(s) => assert_eq!(s, "Here is the answer"),
            _ => panic!("expected Text entry"),
        }
    }

    #[test]
    fn parse_blocks_trims_whitespace_on_text_entries() {

        let blocks = vec![json!({"type": "text", "text": "   padded   "})];
        let out = parse_server_tool_blocks(&blocks);
        match &out[0] {
            ResultEntry::Text(s) => assert_eq!(s, "padded"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn parse_blocks_drops_empty_text_before_server_tool_use() {

        let blocks = vec![
            json!({"type": "text", "text": "   "}),
            json!({"type": "server_tool_use", "id": "stu_1", "name": "web_search"}),
            json!({
                "type": "web_search_tool_result",
                "tool_use_id": "stu_1",
                "content": [{"title": "T", "url": "https://t.example/"}],
            }),
        ];
        let out = parse_server_tool_blocks(&blocks);
        assert_eq!(out.len(), 1);
        match &out[0] {
            ResultEntry::Result(r) => {
                assert_eq!(r.tool_use_id, "stu_1");
                assert_eq!(r.content.len(), 1);
                assert_eq!(r.content[0].title, "T");
            }
            _ => panic!("expected Result"),
        }
    }

    #[test]
    fn parse_blocks_full_upstream_sequence() {

        let blocks = vec![
            json!({"type": "text", "text": "Searching now."}),
            json!({"type": "server_tool_use", "id": "stu_1", "name": "web_search",
                   "input": {"query": "rust"}}),
            json!({
                "type": "web_search_tool_result",
                "tool_use_id": "stu_1",
                "content": [
                    {"title": "Rust", "url": "https://rust-lang.org/"},
                    {"title": "Docs", "url": "https://doc.rust-lang.org/"},
                ],
            }),
            json!({"type": "text", "text": "Rust is a language."}),
        ];
        let out = parse_server_tool_blocks(&blocks);
        assert_eq!(out.len(), 3);

        match &out[0] {
            ResultEntry::Text(s) => assert_eq!(s, "Searching now."),
            _ => panic!("expected preamble text"),
        }
        match &out[1] {
            ResultEntry::Result(r) => {
                assert_eq!(r.tool_use_id, "stu_1");
                assert_eq!(r.content.len(), 2);
                assert_eq!(r.content[0].url, "https://rust-lang.org/");
            }
            _ => panic!("expected SearchResult"),
        }
        match &out[2] {
            ResultEntry::Text(s) => assert_eq!(s, "Rust is a language."),
            _ => panic!("expected closing text"),
        }
    }

    #[test]
    fn parse_blocks_multiple_searches_in_one_turn() {

        let blocks = vec![
            json!({"type": "server_tool_use", "id": "stu_1", "name": "web_search"}),
            json!({
                "type": "web_search_tool_result",
                "tool_use_id": "stu_1",
                "content": [{"title": "A", "url": "https://a/"}],
            }),
            json!({"type": "server_tool_use", "id": "stu_2", "name": "web_search"}),
            json!({
                "type": "web_search_tool_result",
                "tool_use_id": "stu_2",
                "content": [{"title": "B", "url": "https://b/"}],
            }),
        ];
        let out = parse_server_tool_blocks(&blocks);
        assert_eq!(out.len(), 2);
        for (i, entry) in out.iter().enumerate() {
            match entry {
                ResultEntry::Result(r) => {
                    assert_eq!(r.tool_use_id, format!("stu_{}", i + 1));
                }
                _ => panic!("expected Result"),
            }
        }
    }

    #[test]
    fn parse_blocks_surfaces_error_envelope_as_text_entry() {

        let blocks = vec![
            json!({"type": "server_tool_use", "id": "stu_1", "name": "web_search"}),
            json!({
                "type": "web_search_tool_result",
                "tool_use_id": "stu_1",
                "content": {"error_code": "rate_limited"},
            }),
        ];
        let out = parse_server_tool_blocks(&blocks);
        assert_eq!(out.len(), 1);
        match &out[0] {
            ResultEntry::Text(s) => assert_eq!(s, "Web search error: rate_limited"),
            _ => panic!("expected Text entry for error"),
        }
    }

    #[test]
    fn parse_blocks_accumulates_text_deltas_in_preamble() {

        let blocks = vec![
            json!({"type": "text", "text": "Hello "}),
            json!({"type": "text", "text": "there."}),
            json!({"type": "server_tool_use", "id": "stu_1", "name": "web_search"}),
            json!({
                "type": "web_search_tool_result",
                "tool_use_id": "stu_1",
                "content": [{"title": "T", "url": "https://t/"}],
            }),
        ];
        let out = parse_server_tool_blocks(&blocks);
        assert_eq!(out.len(), 2);
        match &out[0] {
            ResultEntry::Text(s) => assert_eq!(s, "Hello there."),
            _ => panic!("expected accumulated preamble"),
        }
    }

    #[test]
    fn parse_blocks_ignores_unknown_types() {

        let blocks = vec![
            json!({"type": "thinking", "thinking": "internal"}),
            json!({"type": "citation", "text": "cite"}),
            json!({"type": "server_tool_use", "id": "stu_1", "name": "web_search"}),
            json!({
                "type": "web_search_tool_result",
                "tool_use_id": "stu_1",
                "content": [{"title": "T", "url": "https://t/"}],
            }),
        ];
        let out = parse_server_tool_blocks(&blocks);
        assert_eq!(out.len(), 1);
        matches!(out[0], ResultEntry::Result(_));
    }

    #[test]
    fn parse_blocks_tolerates_missing_hit_fields() {

        let blocks = vec![
            json!({"type": "server_tool_use", "id": "stu_1", "name": "web_search"}),
            json!({
                "type": "web_search_tool_result",
                "tool_use_id": "stu_1",
                "content": [{"title": "Only title"}],
            }),
        ];
        let out = parse_server_tool_blocks(&blocks);
        match &out[0] {
            ResultEntry::Result(r) => {
                assert_eq!(r.content[0].title, "Only title");
                assert_eq!(r.content[0].url, "");
            }
            _ => panic!("expected Result"),
        }
    }

    #[test]
    fn search_hit_to_json_drops_everything_but_title_and_url() {

        let hit = SearchHit {
            title: "T".into(),
            url: "https://t/".into(),
        };
        let v = hit.to_json();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 2);
        assert!(obj.contains_key("title"));
        assert!(obj.contains_key("url"));
    }

    fn normalize_volatile_fields(v: &mut Value) {
        if let Some(slot) = v.pointer_mut("/system/0/text") {
            *slot = Value::String("BILLING_HEADER_SENTINEL".into());
        }
        if let Some(slot) = v.pointer_mut("/metadata/user_id") {
            *slot = Value::String("USER_ID_SENTINEL".into());
        }
    }

    #[test]
    fn request_body_matches_websearch_capture_structurally() {

        let capture_json = r#"{
          "model": "claude-opus-4-7",
          "messages": [
            {
              "role": "user",
              "content": [
                {
                  "type": "text",
                  "text": "Perform a web search for the query: claude mythos",
                  "cache_control": {"type": "ephemeral"}
                }
              ]
            }
          ],
          "system": [
            {
              "type": "text",
              "text": "x-anthropic-billing-header: cc_version=2.1.113.280; cc_entrypoint=cli; cch=8b3dc;"
            },
            {
              "type": "text",
              "text": "You are Claude Code, Anthropic's official CLI for Claude.",
              "cache_control": {"type": "ephemeral"}
            },
            {
              "type": "text",
              "text": "You are an assistant for performing a web search tool use",
              "cache_control": {"type": "ephemeral"}
            }
          ],
          "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}],
          "metadata": {
            "user_id": "{\"device_id\":\"XXX_DEVICE_ID_XXX\",\"account_uuid\":\"XXX_ACCOUNT_UUID_XXX\",\"session_id\":\"XXX_SESSION_ID_XXX\"}"
          },
          "max_tokens": 64000,
          "thinking": {"type": "adaptive"},
          "context_management": {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]},
          "output_config": {"effort": "xhigh"},
          "stream": true
        }"#;
        let mut expected: Value = serde_json::from_str(capture_json).unwrap();

        let backend = AnthropicServerToolBackend {
            allowed_domains: vec![],
            blocked_domains: vec![],
        };
        let body = backend.build_request_body("claude mythos");
        let mut actual: Value = serde_json::from_slice(&body).unwrap();

        normalize_volatile_fields(&mut expected);
        normalize_volatile_fields(&mut actual);

        assert_eq!(
            actual, expected,
            "web_search body drifted from the 2026-04-19 capture"
        );
    }

    #[test]
    fn search_result_to_json_carries_tool_use_id() {
        let r = SearchResult {
            tool_use_id: "stu_42".into(),
            content: vec![SearchHit {
                title: "T".into(),
                url: "https://t/".into(),
            }],
        };
        let v = r.to_json();
        assert_eq!(v["tool_use_id"], "stu_42");
        let content = v["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
    }
}
