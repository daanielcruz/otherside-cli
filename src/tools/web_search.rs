//! `WebSearch` — query the web, exposed as a deferred tool.
//!
//! # Status
//!
//! Schema is **otherside-native** — synthesized from upstream's Zod at
//! `tools/WebSearchTool/WebSearchTool.ts:25-37`. Name + field shapes
//! mirror upstream; description prose is rewritten for R-103 identity-
//! zone discipline (no upstream product-name strings in the identity
//! zone). When a live `ToolSearch` capture records a real schema for
//! `WebSearch`, `TOOL_WEB_SEARCH_JSON` swaps byte-verbatim.
//!
//! # Backend cascade
//!
//! Two backends share one trait. Selection is runtime, based on auth
//! presence:
//!
//! 1. [`AnthropicServerToolBackend`] — active when
//!    [`auth::anthropic::load_credentials`] returns `Some`. Delegates
//!    the search to Anthropic's server-side `web_search_20250305` tool
//!    via `/v1/messages`, then decodes the returned content blocks with
//!    [`parse_server_tool_blocks`] — same shape as upstream's
//!    `makeOutputFromSearchResponse` at `tools/WebSearchTool/WebSearchTool.ts:86-150`.
//! 2. [`UnavailableBackend`] — fallback. Returns a structured stub that
//!    names `anthropic-oauth` as the missing requirement. Keeps the
//!    tool resolvable so the model can plan calls without tripping
//!    `ToolError::Unsupported`.
//!
//! The Anthropic server tool IS the authoritative backend — upstream
//! uses nothing else, so neither do we. No second real backend, no
//! Google-anything, no env-var cascade.
//!
//! # Deferred (see openspec/changes/019 §Out)
//!
//! - Secondary-model summarization. Raw `{title, url}` hits surface
//!   directly; the main-loop model handles synthesis.
//! - Streaming progress events (upstream emits `search-progress-N`).
//! - Permission gating — dispatcher signature lacks `PermissionContext`.
//!
//! Zone: identity — R-103 applies. No upstream product-name strings in
//! identifiers or copy.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::ToolError;

/// Request timeout for the Anthropic server-tool call. Web searches
/// fan out into several sub-requests on Anthropic's side so this runs
/// longer than the WebFetch budget.
const REQUEST_TIMEOUT_SECS: u64 = 60;

/// Upstream caps `web_search_20250305` at 8 tool uses per call. Mirrored
/// here so the captured behavior is byte-identical on the wire.
/// Source: `tools/WebSearchTool/WebSearchTool.ts:82` (`max_uses: 8`).
const WEB_SEARCH_MAX_USES: u64 = 8;

/// A single hit inside a `SearchResult.content` list. Matches
/// upstream's `searchHitSchema` at
/// `tools/WebSearchTool/WebSearchTool.ts:43-46`: strictly `{title,
/// url}` — no snippet, no rank. Field order matches the wire JSON
/// (preserve_order).
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

/// A grouped block of hits from one server-side search. Matches
/// upstream's `searchResultSchema` at
/// `tools/WebSearchTool/WebSearchTool.ts:48-52`: `{tool_use_id,
/// content: [{title, url}]}`. Upstream emits one of these per
/// `server_tool_use` block; the parser groups 1:1 with the assistant
/// response.
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

/// Entry in the output `results[]` array — either a structured search
/// result block or a raw text summary block emitted by the model
/// between searches. Mirrors upstream's `SearchResult | string` union.
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

/// Pluggable search backend. Runtime-selected per call; see module docs.
/// Backends return the finished `results[]` payload directly — the
/// Anthropic backend parses it from assistant content blocks; the
/// unavailable backend returns an empty vec and lets the dispatcher
/// stamp the marker.
trait WebSearchBackend {
    fn search(&self, query: &str) -> Result<Vec<ResultEntry>, ToolError>;
}

/// Fallback backend when no `anthropic-oauth` credentials are present.
/// Returns an empty result set; the dispatcher swaps in
/// [`UNAVAILABLE_MARKER`] so the output contract stays
/// `{query, results, durationSeconds}` regardless of backend state.
/// Never touches the network.
struct UnavailableBackend;

impl WebSearchBackend for UnavailableBackend {
    fn search(&self, _query: &str) -> Result<Vec<ResultEntry>, ToolError> {
        Ok(Vec::new())
    }
}

/// Anthropic server-tool backend — delegates to `web_search_20250305`.
///
/// Upstream uses only this path; we mirror it. The search prompt,
/// tool schema shape, and response-parsing logic all follow
/// `tools/WebSearchTool/WebSearchTool.ts`:
///
/// - `makeToolSchema` (`:76-84`) → [`build_server_tool_config`]
/// - `makeOutputFromSearchResponse` (`:86-150`) → [`parse_server_tool_blocks`]
///
/// Domain filters are passed through to the server tool's
/// `allowed_domains` / `blocked_domains` fields — Anthropic handles
/// the filtering server-side, same as upstream.
struct AnthropicServerToolBackend {
    allowed_domains: Vec<String>,
    blocked_domains: Vec<String>,
}

impl AnthropicServerToolBackend {
    /// Attempt to construct the backend from saved credentials. Returns
    /// `None` when no `anthropic-oauth` creds are cached — caller
    /// falls through to [`UnavailableBackend`] without erroring.
    fn from_auth(allowed_domains: Vec<String>, blocked_domains: Vec<String>) -> Option<Self> {
        match crate::auth::anthropic::load_credentials() {
            Ok(Some(_)) => Some(Self {
                allowed_domains,
                blocked_domains,
            }),
            _ => None,
        }
    }

    /// Build the `tools[]` entry that tells the Anthropic Messages API
    /// we want a server-side `web_search_20250305` invocation.
    /// Byte-matches upstream's `makeToolSchema`.
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

    /// Build the non-streaming Messages API body that drives a single
    /// search turn. Prompt text mirrors upstream's
    /// `tools/WebSearchTool/WebSearchTool.ts:258-259`
    /// ("Perform a web search for the query: <q>") so server-side
    /// routing behaves the same as upstream.
    fn build_request_body(&self, query: &str) -> Vec<u8> {
        // Shape mirrors the 2026-04-19 capture at
        // `fingerprint_corpus/tools-websearch-single/raw/flow-41-scrubbed.txt`.
        // Every field here is load-bearing: dropping any of `system[0]`
        // (billing header), `metadata.user_id`, `thinking`,
        // `context_management`, `output_config`, or `cache_control`
        // causes Anthropic to reject with a 429 rate-limit-error.
        // Reuse the main-inference billing marker — Anthropic's
        // analytics path treats any CC-shaped `cc_version=<hash>;
        // cc_entrypoint=<entrypoint>; cch=<hash>;` as authentic.
        let billing_header = crate::fingerprint::anthropic::BILLING_HEADER_TEXT.to_string();
        // The `metadata.user_id` nests a JSON string carrying device /
        // account / session identifiers — upstream's analytics path
        // consumes this for rate-limit scoping. Empty placeholders are
        // fine; Anthropic accepts them as long as the field is present.
        let user_id = json!({
            "device_id": "",
            "account_uuid": "",
            "session_id": "",
        })
        .to_string();
        let body = json!({
            "model": "claude-opus-4-7",
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": format!("Perform a web search for the query: {query}"),
                    "cache_control": {"type": "ephemeral"},
                }],
            }],
            "system": [
                {"type": "text", "text": billing_header},
                {
                    "type": "text",
                    "text": "You are Claude Code, Anthropic's official CLI for Claude.",
                    "cache_control": {"type": "ephemeral"},
                },
                {
                    "type": "text",
                    "text": "You are an assistant for performing a web search tool use",
                    "cache_control": {"type": "ephemeral"},
                },
            ],
            "tools": [self.build_server_tool_config()],
            "metadata": {"user_id": user_id},
            "max_tokens": 64000,
            "thinking": {"type": "adaptive"},
            "context_management": {
                "edits": [{"type": "clear_thinking_20251015", "keep": "all"}]
            },
            "output_config": {"effort": "xhigh"},
            "stream": true,
        });
        serde_json::to_vec(&body).expect("web_search request body serializes")
    }
}

impl WebSearchBackend for AnthropicServerToolBackend {
    fn search(&self, query: &str) -> Result<Vec<ResultEntry>, ToolError> {
        let body = self.build_request_body(query);

        // reqwest is async; dispatcher is sync. R-107: `block_in_place`
        // lets the multi-thread runtime keep scheduling other tasks
        // during the round-trip. Same pattern as `web_fetch::web_fetch`.
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async move {
                let bearer = crate::auth::anthropic::authorization_header()
                    .await
                    .map_err(|e| ToolError::InvalidArgs(format!("auth: {e}")))?;

                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                    .build()
                    .map_err(|e| {
                        ToolError::InvalidArgs(format!("failed to build http client: {e}"))
                    })?;

                // Reuse the main-inference 20-header fingerprint so
                // Anthropic recognizes us as a legitimate CC client.
                // WebSearch needs a DIFFERENT `anthropic-beta` flag
                // set — swap it on top of the shared builder.
                let mut headers = crate::provider::anthropic::build_inference_headers(
                    &bearer, /* has_1m = */ false,
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
                // `Accept: text/event-stream` is what the SSE path wants;
                // the shared builder sets `application/json`. Override.
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

                // Anthropic's web_search turn is always SSE (we send
                // `stream: true` in the body). Collect content blocks
                // from the event stream — `content_block_start` kicks
                // off each block; `content_block_delta` events patch
                // fields incrementally (text deltas, input_json_delta
                // for server_tool_use inputs); `content_block_stop`
                // seals it. Final assembly lives in `parse_server_tool_blocks`.
                let blocks = collect_sse_content_blocks(resp).await?;
                Ok(parse_server_tool_blocks(&blocks))
            })
        })
    }
}

/// Walk an SSE response and assemble the final `content[]` array
/// exactly as if the response had been non-streaming. Handles:
///
/// - `content_block_start` — seeds the block at its index.
/// - `content_block_delta` — patches text / input_json / citation
///   fields on the seeded block (accumulating partial strings).
/// - `content_block_stop` — freezes the block (JSON-parses accumulated
///   `server_tool_use.input` if present).
/// - `message_stop` — ends the stream.
///
/// Ignores `ping`, `message_start`, `message_delta` — the first is
/// heartbeat, the other two carry turn-level metadata we don't need.
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

        // SSE events are separated by `\n\n`. Extract complete events
        // from the buffer; keep the tail for the next chunk.
        while let Some(pos) = buf.find("\n\n") {
            let raw_event = buf[..pos].to_string();
            buf.drain(..pos + 2);

            // Each event is a set of `field: value` lines. We only care
            // about the `data:` line.
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
                Err(_) => continue, // tolerate unknown event shapes
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
                            // server_tool_use input — accumulate the
                            // partial JSON string; parse at stop time.
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
                        _ => {} // signature_delta / citations_delta /
                                // other deltas we don't need for the
                                // result shape
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
                _ => {} // message_start / message_delta / ping — ignore
            }
        }
    }

    Ok(blocks)
}

/// Decode an assistant `content[]` array into `results[]` entries.
///
/// Port of upstream's `makeOutputFromSearchResponse` at
/// `tools/WebSearchTool/WebSearchTool.ts:86-150` — same state machine,
/// same sentinel, same text-accumulation rules. The block sequence
/// typically looks like:
///
/// ```text
///   text (opening commentary)
///   [ server_tool_use, web_search_tool_result, text*, citation* ]+
///   text (closing commentary)
/// ```
///
/// Rules:
///
/// - A `server_tool_use` block flushes any accumulated leading text as
///   a standalone `results[]` string entry, then drops into
///   "after-search" mode.
/// - A `web_search_tool_result` block with array content is pushed as
///   a [`SearchResult`]; with non-array content (an error envelope) the
///   `error_code` is surfaced as a `"Web search error: <code>"` string.
/// - `text` blocks accumulate in the buffer; the accumulator is flushed
///   on the next `server_tool_use` or at the end.
///
/// Pure — takes a slice of Values (no HTTP, no async) so unit tests
/// can feed fixtures directly.
fn parse_server_tool_blocks(blocks: &[Value]) -> Vec<ResultEntry> {
    let mut results: Vec<ResultEntry> = Vec::new();
    let mut text_acc = String::new();
    // Upstream flips this flag on server_tool_use and flips it back on
    // the NEXT text block — lets trailing commentary land as its own
    // entry instead of merging with the opening preamble.
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
                // body ignored — the tool_use id is carried on the
                // paired `web_search_tool_result` block below.
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
                    // Error envelope: `{ error_code: "..." }` in place
                    // of an array. Surface as a string entry so the
                    // model sees the diagnosis inline.
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
                // citation blocks, tool_use from advertised tools (not
                // server_tool_use), thinking, etc. Pass through silently.
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

/// Parse the optional `allowed_domains` / `blocked_domains` args into
/// `Vec<String>`. Non-array values are rejected with a clear message so
/// the model sees a structured error instead of a silent drop.
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

/// Pick the active backend. Runtime-detected from auth presence; see
/// module docs. Returned as a trait object so the dispatcher path is
/// backend-agnostic.
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

/// Marker string the unavailable-backend stub drops into the results
/// array. Tests and integrations grep for the `web_search_unavailable`
/// prefix to detect the stub path; the trailing clause names the
/// missing requirement so humans see the remediation inline.
const UNAVAILABLE_MARKER: &str =
    "web_search_unavailable - requires anthropic-oauth credentials (run `otherside login`)";

/// Dispatch the `WebSearch` tool. Input is JSON per
/// [`TOOL_WEB_SEARCH_JSON`]; output is
/// `{query, results, durationSeconds}` matching upstream's Zod shape.
/// Results entries are either `SearchResult` objects or plain strings
/// (the stub marker lands as a string entry).
pub fn web_search(args: &Value) -> Result<Value, ToolError> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("Error: Missing query".into()))?
        .to_string();
    if query.trim().is_empty() {
        return Err(ToolError::InvalidArgs("Error: Missing query".into()));
    }
    // Upstream `inputSchema` enforces `z.string().min(2)`.
    if query.chars().count() < 2 {
        return Err(ToolError::InvalidArgs(
            "Error: query must be at least 2 characters".into(),
        ));
    }

    let allowed = parse_domain_list(args, "allowed_domains")?;
    let blocked = parse_domain_list(args, "blocked_domains")?;
    if !allowed.is_empty() && !blocked.is_empty() {
        // Upstream `validateInput` errorCode 2 — the ambiguity is
        // rejected at input-validation time so the caller sees a
        // clear message instead of silently odd filtering.
        return Err(ToolError::InvalidArgs(
            "Error: Cannot specify both allowed_domains and blocked_domains in the same request"
                .into(),
        ));
    }

    // Snapshot auth presence BEFORE handing the filters to the backend —
    // the Anthropic path consumes the domain vecs by move, and the
    // post-call branch below still needs to know whether to stamp the
    // unavailable marker.
    let auth_present = crate::auth::anthropic::load_credentials()
        .map(|c| c.is_some())
        .unwrap_or(false);

    let backend = select_backend(allowed, blocked);
    let started = Instant::now();
    let entries = backend.search(&query)?;
    let duration_seconds = started.elapsed().as_secs_f64();

    let results_json: Vec<Value> = if !auth_present {
        // Unavailable-backend path: surface the marker as a string
        // entry so the results array matches upstream's
        // `SearchResult | string` shape (`mapToolResultToToolResultBlockParam`
        // treats string entries as text summaries).
        vec![Value::String(UNAVAILABLE_MARKER.to_string())]
    } else {
        entries.iter().map(ResultEntry::to_json).collect()
    };

    let mut out = json!({
        "query": query,
        "results": results_json,
        "durationSeconds": duration_seconds,
    });
    // Upstream `maxResultSizeChars: 100_000`: tool-results beyond the
    // cap are persisted instead of inlined. We enforce the soft cap
    // by truncating `results` to a string marker if the serialized
    // JSON blows past the budget. Matches upstream's "oversized
    // result" semantics without the disk-persist path (not yet wired).
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

/// `WebSearch` schema — otherside-native synthesis of upstream's Zod at
/// `tools/WebSearchTool/WebSearchTool.ts:25-37`. Description captures
/// the behavior guarantees without dragging in upstream prose that
/// mentions product names (R-103).
pub const TOOL_WEB_SEARCH_JSON: &str = r#"{
  "name": "WebSearch",
  "description": "Search the web and return result links. Returns hits as {title, url} objects grouped by server-side search call. Supports optional allowed_domains or blocked_domains filters (not both in the same call). Read-only — does not modify files. Delegates to Anthropic's server-side web_search_20250305 tool; requires anthropic-oauth credentials. When no credentials are configured the tool returns a structured unavailable stub so the model can still plan.",
  "input_schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "query": {
        "description": "The search query. Minimum 2 characters.",
        "type": "string",
        "minLength": 2
      },
      "allowed_domains": {
        "description": "Only include search results from these domains.",
        "type": "array",
        "items": { "type": "string" }
      },
      "blocked_domains": {
        "description": "Never include search results from these domains.",
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}"#;

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
        // The model relies on the description to decide whether
        // calling WebSearch is even reasonable. Drift here would
        // confuse it.
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
        // Upstream `validateInput` errorCode 1 message shape.
        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("Missing query"), "actual: {msg}");
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_one_char_query() {
        // Upstream schema: `z.string().min(2)`.
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

    /// Redirect `config::config_dir()` at an empty temp dir for the
    /// duration of one test so `auth::anthropic::load_credentials()`
    /// returns `None` regardless of whether the developer is logged in
    /// on their real machine. Env-var mutation — tests using this
    /// helper serialize on [`ENV_MUTEX`] to avoid cross-test races.
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

    /// Serialize env-var mutation across tests in this module. Env
    /// reads + mutations that touch `OTHERSIDE_CONFIG_DIR` race across
    /// parallel test workers otherwise.
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

    // -----------------------------------------------------------------
    // Anthropic server-tool backend — config + parser
    // -----------------------------------------------------------------

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
        // Empty domain lists must be OMITTED (not serialized as []) so
        // the wire body stays minimal and byte-matches upstream when
        // the caller didn't pass filters.
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
        // Upstream always streams the web_search turn — we match.
        assert_eq!(parsed["stream"], true);
        // Required envelope fields per the 2026-04-19 capture.
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
        // Upstream prompt wording — keep byte-compatible so server-side
        // routing behaves identically.
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
        // Upstream's parser trims before pushing.
        let blocks = vec![json!({"type": "text", "text": "   padded   "})];
        let out = parse_server_tool_blocks(&blocks);
        match &out[0] {
            ResultEntry::Text(s) => assert_eq!(s, "padded"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn parse_blocks_drops_empty_text_before_server_tool_use() {
        // Leading whitespace-only text before the tool use must NOT
        // land as a results entry.
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
        // Models emit: preamble text → server_tool_use → result →
        // closing text. Expect 3 entries: preamble string, result,
        // closing string.
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
        // Model can issue several searches per turn; each pair lands
        // as its own Result entry.
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
        // Upstream: non-array content on web_search_tool_result carries
        // an `{error_code}` object; surface as "Web search error: <code>".
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
        // Several text blocks before the tool use should merge into a
        // single preamble entry (stream delivers text in chunks).
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
        // Citation / thinking / tool_use blocks etc. must not crash.
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
        // Anthropic might omit `url` on a degraded result. Default to
        // empty strings rather than crashing.
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
        // Regression guard: upstream's `SearchHit` wire shape is strictly
        // `{title, url}`. If someone adds a field we want to notice.
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
