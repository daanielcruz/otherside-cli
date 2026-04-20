//! `WebSearch` — schema + per-provider dispatch. Today only the
//! claude-code backend is wired; codex and gemini dispatch return a
//! clear Unsupported so the nested model can adapt.

pub mod claude_code;

pub use claude_code::TOOL_WEB_SEARCH_JSON;

use serde_json::Value;

use crate::config::providers::ProviderId;
use crate::tools::ToolError;

pub fn dispatch(args: &Value, provider: ProviderId) -> Result<Value, ToolError> {
    match provider {
        ProviderId::ClaudeCode => claude_code::web_search(args),
        ProviderId::Codex | ProviderId::GeminiCli | ProviderId::OpenAiCustom => {
            Err(ToolError::Unsupported(format!(
                "WebSearch backend for provider `{}` is not wired yet",
                provider.slug()
            )))
        }
    }
}
