

pub mod claude_code;
pub mod codex;

pub use claude_code::TOOL_WEB_SEARCH_JSON;

use serde_json::Value;

use crate::config::providers::ProviderId;
use crate::tools::ToolError;

pub fn dispatch(args: &Value, provider: ProviderId) -> Result<Value, ToolError> {
    match provider {
        ProviderId::ClaudeCode => claude_code::web_search(args),
        ProviderId::Codex => codex::web_search(args),
        ProviderId::GeminiCli | ProviderId::OpenAiCustom => {
            Err(ToolError::Unsupported(format!(
                "WebSearch backend for provider `{}` is not wired yet",
                provider.slug()
            )))
        }
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_routes_to_codex_module() {
        let out = dispatch(&json!({"query": "rust"}), ProviderId::Codex).unwrap();
        let results = out["results"].as_array().unwrap();
        let marker = results[0].as_str().unwrap();
        assert!(marker.contains("codex"));
    }

    #[test]
    fn claude_code_rejects_empty_query_early() {
        // Route-to-claude-module check. The claude path validates arguments
        // synchronously before touching the runtime, so short-circuits on
        // empty queries without needing a reactor.
        let err = dispatch(&json!({"query": ""}), ProviderId::ClaudeCode).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("Missing query")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn gemini_remains_unsupported() {
        let err = dispatch(&json!({"query": "rust"}), ProviderId::GeminiCli).unwrap_err();
        match err {
            ToolError::Unsupported(msg) => assert!(msg.contains("gemini")),
            _ => panic!("expected Unsupported"),
        }
    }
}
