//! Codex web_search shim. Unlike Anthropic's server tool which we hit via
//! `/v1/messages` with `type: "web_search_20250305"` (see claude_code.rs),
//! Codex's `/responses` API performs web_search inline: the model emits
//! `web_search_call` output items and the server runs the search. Our
//! responsibility is (a) to advertise the server tool in the request body
//! (done by the request translator in src/translator/codex/request.rs:
//! `openai_tools_to_codex_tools` rewrites `WebSearch` -> `{type:"web_search",
//! external_web_access:true}`), and (b) decode `web_search_call` output items
//! on the response side (done in src/translator/codex/response.rs).
//!
//! Client-side dispatch is unreachable in the happy path — the model never
//! emits a `WebSearch` function call against codex because the function-tool
//! entry was replaced upstream by the server tool. This shim still needs
//! to exist so the dispatch matrix is symmetric when something goes wrong
//! (e.g. stale rollout where the model thinks the function tool still
//! exists). The returned marker lets the agent loop keep running and the
//! user sees a clear explanation.
//!
//! Reference: openai/codex
//! - codex-rs/tools/src/tool_spec.rs:43-55 (enum variant `WebSearch`)
//! - codex-rs/tools/src/tool_spec.rs:93-129 (`create_web_search_tool`)
//! - codex-rs/protocol/src/models.rs:555-565 (`WebSearchCall` output item)
//! - codex-rs/protocol/src/models.rs:861-889 (`WebSearchAction` variants)

use serde_json::{json, Value};

use crate::tools::ToolError;

/// Returned when the codex path is dispatched client-side. Explains why there
/// are no results: codex's server tool owns the search and emits results via
/// `response.output_item.added` with item.type = "web_search_call".
const CODEX_SERVER_TOOL_MARKER: &str =
    "web_search_codex_server_side - codex performs web_search on the /responses \
     server; client-side dispatch returns no results. If you see this, the \
     model function-called WebSearch directly instead of using the server \
     tool — check that the codex translator's `openai_tools_to_codex_tools` \
     rewrote WebSearch to `{type:\"web_search\"}`.";

pub fn web_search(args: &Value) -> Result<Value, ToolError> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if query.trim().is_empty() {
        return Err(ToolError::InvalidArgs("Error: Missing query".into()));
    }

    Ok(json!({
        "query": query,
        "results": vec![Value::String(CODEX_SERVER_TOOL_MARKER.to_string())],
        "durationSeconds": 0.0,
    }))
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
    fn returns_server_tool_marker_for_valid_query() {
        let out = web_search(&json!({"query": "rust tokio"})).unwrap();
        assert_eq!(out["query"], "rust tokio");
        let results = out["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        let marker = results[0].as_str().unwrap();
        assert!(marker.contains("codex"));
        assert!(marker.contains("server"));
    }

    #[test]
    fn marker_points_at_translator_check() {
        let out = web_search(&json!({"query": "anything"})).unwrap();
        let marker = out["results"][0].as_str().unwrap();
        assert!(
            marker.contains("openai_tools_to_codex_tools"),
            "marker should name the translator fn so operators can debug, got: {marker}"
        );
    }
}
