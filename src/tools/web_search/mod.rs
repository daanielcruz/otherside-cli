
pub mod claude_code;
pub mod codex;
pub mod kimi;

pub use claude_code::TOOL_WEB_SEARCH_JSON;

use serde_json::Value;

use crate::config::providers::ProviderId;
use crate::tools::ToolError;

pub fn dispatch(args: &Value, provider: ProviderId) -> Result<Value, ToolError> {
    match provider {
        ProviderId::ClaudeCode => claude_code::web_search(args),
        ProviderId::Codex => codex::web_search(args),
        ProviderId::Kimi => kimi::web_search(args),
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

    #[test]
    fn thread_local_provider_controls_dispatch_branch() {
        
        use crate::tools;

        let codex_out = tools::with_current_provider(ProviderId::Codex, || {
            tools::dispatch("WebSearch", &json!({"query": "tokio"}))
        })
        .unwrap();
        let marker = codex_out["results"][0].as_str().unwrap();
        assert!(marker.contains("codex"),
            "codex scope must land in codex shim, got: {marker}");

        let claude_err = tools::with_current_provider(ProviderId::ClaudeCode, || {
            tools::dispatch("WebSearch", &json!({"query": ""}))
        })
        .unwrap_err();
        match claude_err {
            ToolError::InvalidArgs(msg) => assert!(
                msg.contains("Missing query"),
                "claude scope must reach claude_code validator, got: {msg}"
            ),
            _ => panic!("expected InvalidArgs"),
        }
    }
}
