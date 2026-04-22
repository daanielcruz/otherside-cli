//! Kimi web_search shim. Kimi exposes a native `$web_search` builtin on the
//! OpenAI-compat endpoint (`/v1/chat/completions`). Unlike Anthropic's server
//! tool (`web_search_20250305` on `/v1/messages`) and Codex's server tool
//! (`web_search` on `/responses`), Moonshot's `$web_search` is a
//! `builtin_function` round-trip: the client declares `$web_search` in
//! `tools[]`, the model emits a `tool_call` whose `function.arguments` holds
//! the search parameters, the client echoes those arguments back verbatim as
//! a `tool` message, and the server performs the actual search before
//! returning a final text completion that integrates the results.
//!
//! Doc: <https://platform.kimi.ai/docs/guide/use-web-search>.
//!
//! Endpoint override via `OTHERSIDE_KIMI_OPENAI_URL` — default is
//! `https://api.moonshot.ai/v1/chat/completions`. Kimi-for-coding deployments
//! may host the OpenAI-compat surface behind a different host; the env knob
//! keeps us from hard-coding a fragile default.

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

use crate::tools::ToolError;

const DEFAULT_OPENAI_URL: &str = "https://api.moonshot.ai/v1/chat/completions";
const DEFAULT_MODEL: &str = "kimi-k2-thinking";
const REQUEST_TIMEOUT_SECS: u64 = 60;
const MAX_ROUNDTRIPS: usize = 3;

fn openai_url() -> String {
    std::env::var("OTHERSIDE_KIMI_OPENAI_URL").unwrap_or_else(|_| DEFAULT_OPENAI_URL.to_string())
}

fn search_model() -> String {
    std::env::var("OTHERSIDE_KIMI_SEARCH_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string())
}

pub fn web_search(args: &Value) -> Result<Value, ToolError> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if query.trim().is_empty() {
        return Err(ToolError::InvalidArgs("Error: Missing query".into()));
    }

    let api_key = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(crate::auth::kimi::current_api_key())
    })
    .map_err(|e| ToolError::InvalidArgs(format!("kimi auth: {e}")))?;

    let client = crate::tools::http::default_client(REQUEST_TIMEOUT_SECS)?;

    let headers = build_headers(&api_key)?;

    let mut messages: Vec<Value> = vec![
        json!({
            "role": "system",
            "content": "You are an assistant for performing a web search. Use the $web_search tool to look up current information and return the raw findings.",
        }),
        json!({
            "role": "user",
            "content": format!("Perform a web search for: {query}"),
        }),
    ];

    let tools = vec![json!({
        "type": "builtin_function",
        "function": {"name": "$web_search"},
    })];

    let url = openai_url();
    let model = search_model();

    for _ in 0..MAX_ROUNDTRIPS {
        let body = json!({
            "model": model,
            "messages": messages,
            "tools": tools,
            "stream": false,
        });
        let resp = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                client
                    .post(&url)
                    .headers(headers.clone())
                    .json(&body)
                    .send()
                    .await
            })
        })
        .map_err(|e| ToolError::InvalidArgs(format!("kimi web_search send: {e}")))?;

        let status = resp.status();
        let body_text = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(resp.text())
        })
        .unwrap_or_default();

        if !status.is_success() {
            return Err(ToolError::InvalidArgs(format!(
                "kimi $web_search returned http {}: {}",
                status.as_u16(),
                truncate(&body_text, 400)
            )));
        }

        let parsed: Value = serde_json::from_str(&body_text).map_err(|e| {
            ToolError::InvalidArgs(format!("kimi $web_search parse: {e} — body: {body_text}"))
        })?;

        let choice = parsed
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .ok_or_else(|| ToolError::InvalidArgs("kimi $web_search: no choices in response".into()))?;
        let msg = choice
            .get("message")
            .ok_or_else(|| ToolError::InvalidArgs("kimi $web_search: choice.message missing".into()))?;

        let tool_calls = msg
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        if tool_calls.is_empty() {
            let final_text = msg.get("content").and_then(Value::as_str).unwrap_or("");
            return Ok(json!({
                "query": query,
                "results": vec![Value::String(final_text.to_string())],
                "durationSeconds": 0.0,
            }));
        }

        messages.push(msg.clone());
        for call in tool_calls {
            let call_id = call.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let function = call.get("function").cloned().unwrap_or(Value::Null);
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if name != "$web_search" {
                return Err(ToolError::InvalidArgs(format!(
                    "kimi emitted unexpected tool_call `{name}` — only $web_search expected"
                )));
            }
            let arguments = function
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "name": "$web_search",
                "content": arguments,
            }));
        }
    }

    Err(ToolError::InvalidArgs(format!(
        "kimi $web_search exceeded {MAX_ROUNDTRIPS} round-trips without producing final content"
    )))
}

fn build_headers(api_key: &str) -> Result<HeaderMap, ToolError> {
    let mut h = HeaderMap::new();
    let auth_val = format!("Bearer {api_key}");
    h.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&auth_val)
            .map_err(|e| ToolError::InvalidArgs(format!("kimi header: {e}")))?,
    );
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok(h)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_query() {
        let err = web_search(&json!({})).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("query")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn rejects_empty_query() {
        let err = web_search(&json!({"query": "   "})).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("Missing query")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn openai_url_env_override_wins() {
        let prev = std::env::var("OTHERSIDE_KIMI_OPENAI_URL").ok();
        std::env::set_var("OTHERSIDE_KIMI_OPENAI_URL", "https://probe.example/v1/chat/completions");
        assert_eq!(openai_url(), "https://probe.example/v1/chat/completions");
        match prev {
            Some(v) => std::env::set_var("OTHERSIDE_KIMI_OPENAI_URL", v),
            None => std::env::remove_var("OTHERSIDE_KIMI_OPENAI_URL"),
        }
    }

    #[test]
    fn openai_url_default_matches_moonshot() {
        let prev = std::env::var("OTHERSIDE_KIMI_OPENAI_URL").ok();
        std::env::remove_var("OTHERSIDE_KIMI_OPENAI_URL");
        assert_eq!(openai_url(), DEFAULT_OPENAI_URL);
        if let Some(v) = prev {
            std::env::set_var("OTHERSIDE_KIMI_OPENAI_URL", v);
        }
    }

    #[test]
    fn search_model_env_override_wins() {
        let prev = std::env::var("OTHERSIDE_KIMI_SEARCH_MODEL").ok();
        std::env::set_var("OTHERSIDE_KIMI_SEARCH_MODEL", "kimi-probe-model");
        assert_eq!(search_model(), "kimi-probe-model");
        match prev {
            Some(v) => std::env::set_var("OTHERSIDE_KIMI_SEARCH_MODEL", v),
            None => std::env::remove_var("OTHERSIDE_KIMI_SEARCH_MODEL"),
        }
    }

    #[test]
    fn build_headers_carries_bearer() {
        let h = build_headers("sk-kimi-test").unwrap();
        assert_eq!(
            h.get(AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer sk-kimi-test"
        );
        assert_eq!(h.get(CONTENT_TYPE).unwrap(), "application/json");
    }
}
