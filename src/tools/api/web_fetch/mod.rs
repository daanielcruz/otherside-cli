//! `WebFetch` — HTTP GET + HTML→markdown. Schema exported once; the
//! backend currently routes only through `claude_code` because codex
//! and gemini dispatch are frozen.

pub mod claude_code;

// Schema const lives at the backend today so existing callers keep
// their paths stable. Re-export so future backend swaps don't touch
// schemas.rs.
pub use claude_code::TOOL_WEB_FETCH_JSON;

use serde_json::Value;

use crate::config::providers::ProviderId;
use crate::tools::ToolError;

/// Dispatch a WebFetch call against the active provider's backend.
/// Today only the claude-code backend is wired; codex and gemini
/// return a clear error so the nested model can adapt.
pub fn dispatch(args: &Value, provider: ProviderId) -> Result<Value, ToolError> {
    match provider {
        ProviderId::ClaudeCode => claude_code::web_fetch(args),
        ProviderId::Codex | ProviderId::GeminiCli | ProviderId::OpenAiCustom => {
            Err(ToolError::Unsupported(format!(
                "WebFetch backend for provider `{}` is not wired yet",
                provider.slug()
            )))
        }
    }
}
