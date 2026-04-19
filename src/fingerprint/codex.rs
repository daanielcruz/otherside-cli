//! Codex (ChatGPT OAuth) fingerprint — header set + UA literal used on
//! every outbound `/responses` request.
//!
//! Sourced from `docs/design/codex-openai-auth-api.md §FINGERPRINT`.
//! Headers below are the identifying surface a reviewer / firewall
//! would use to fingerprint the client; matching them exactly is the
//! compat-zone contract (R-103).

use uuid::Uuid;

/// Base URL for the ChatGPT-OAuth responses endpoint.
pub const CHATGPT_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";

/// `/responses` is the only endpoint we POST to in ChatGPT mode.
pub const RESPONSES_ENDPOINT: &str = "/responses";

/// `originator` header — upstream's codex-cli signature.
pub const ORIGINATOR: &str = "codex_cli_rs";

/// User-Agent string we send. Matches upstream shape
/// (`codex_cli_rs/<version> (<OS> <ver>; <arch>)`); we omit the
/// trailing terminal identifier since we don't resolve it reliably.
pub fn user_agent() -> String {
    format!(
        "codex_cli_rs/{} ({} unknown; {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

/// Build a stable installation id per process. Upstream persists this
/// across launches; for now we generate once per process and rely on
/// the conversation headers carrying the session UUID.
pub fn installation_id() -> String {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| Uuid::new_v4().to_string()).clone()
}

/// Build a stable window id per process. Same rationale as
/// [`installation_id`].
pub fn window_id() -> String {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| Uuid::new_v4().to_string()).clone()
}

/// Fresh session id for a single conversation. Caller holds onto this
/// for the lifetime of a TUI session.
pub fn new_session_id() -> String {
    Uuid::new_v4().to_string()
}

/// Compose the `ChatGPT-Account-ID` header if the account id is known.
/// Upstream omits the header when no id is present (API-key mode).
pub fn chatgpt_account_id_header(account_id: Option<&str>) -> Option<(&'static str, String)> {
    account_id.map(|id| ("ChatGPT-Account-ID", id.to_string()))
}
