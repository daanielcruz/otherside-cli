

use uuid::Uuid;

pub const CHATGPT_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";

pub const RESPONSES_ENDPOINT: &str = "/responses";

pub const ORIGINATOR: &str = "codex_cli_rs";

pub fn user_agent() -> String {
    format!(
        "codex_cli_rs/{} ({} unknown; {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

pub fn installation_id() -> String {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(load_or_seed_installation_id).clone()
}

pub fn window_id() -> String {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| Uuid::new_v4().to_string()).clone()
}

fn load_or_seed_installation_id() -> String {
    let mut state = crate::config::user_state::load().unwrap_or_default();
    if let Some(id) = state.codex_installation_id.clone() {
        return id;
    }
    let fresh = Uuid::new_v4().to_string();
    state.codex_installation_id = Some(fresh.clone());
    let _ = crate::config::user_state::save(&state);
    fresh
}

pub fn new_session_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn chatgpt_account_id_header(account_id: Option<&str>) -> Option<(&'static str, String)> {
    account_id.map(|id| ("ChatGPT-Account-ID", id.to_string()))
}
