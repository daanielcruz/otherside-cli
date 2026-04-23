
use serde_json::{json, Value};

use crate::tools::ToolError;

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
