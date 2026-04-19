//! Panel handler — mount a modal overlay picker.
//!
//! Delegates to the existing overlay-menu primitive (`tui::menu::OverlayMenu`).
//! Each `PanelKind` variant maps to a constructor that populates the
//! picker with current state-derived options. The event loop captures
//! focus until the user commits (Enter) or cancels (Esc).
//!
//! Info-style panels (`/config`, `/status`, `/skills`, etc.) use the
//! `new_info` constructor with bullet hints — no commit outcome fires,
//! the overlay just acknowledges on Enter.

use super::super::menu;
use super::super::state::ConversationState;
use super::PanelKind;
use super::SlashOutcome;

/// Dispatch a Panel-category slash — mount the overlay matching `kind`
/// and return `Handled`. Event loop routes subsequent key events through
/// `handle_menu_key` until the overlay resolves.
pub fn handle(kind: PanelKind, state: &mut ConversationState) -> SlashOutcome {
    // Clear the input + autocomplete so the typed `/<name>` text doesn't
    // linger in the prompt bar beneath the overlay.
    state.input.clear();
    state.autocomplete = None;
    let overlay = match kind {
        PanelKind::Effort => menu::OverlayMenu::new_effort(state.effort_label),
        PanelKind::Permissions => menu::OverlayMenu::new_permissions(state.permission_mode),
        PanelKind::Model => menu::OverlayMenu::new_model(&state.model),
        PanelKind::Help => menu::OverlayMenu::new_info(
            PanelKind::Help,
            "Slash commands".into(),
            help_hints(),
        ),
        PanelKind::Status => menu::OverlayMenu::new_info(
            PanelKind::Status,
            "Session status".into(),
            status_hints(state),
        ),
        PanelKind::Config => menu::OverlayMenu::new_info(
            PanelKind::Config,
            "Settings snapshot".into(),
            config_hints(state),
        ),
        PanelKind::Skills => menu::OverlayMenu::new_info(
            PanelKind::Skills,
            "Skills".into(),
            vec![
                "Skills are bundled under otherside-cli/skills/.".into(),
                "Use the Skill tool to load one mid-turn.".into(),
            ],
        ),
        PanelKind::Agents => menu::OverlayMenu::new_info(
            PanelKind::Agents,
            "Subagents".into(),
            vec![
                "Subagents live at otherside-cli/agents/.".into(),
                "Invoke via the Agent tool with `subagent_type`.".into(),
            ],
        ),
        PanelKind::Mcp => menu::OverlayMenu::new_info(
            PanelKind::Mcp,
            "MCP servers".into(),
            vec![
                "MCP JSON-RPC client lands in the Phase 3 tier.".into(),
                "No servers active this session.".into(),
            ],
        ),
        PanelKind::Hooks => menu::OverlayMenu::new_info(
            PanelKind::Hooks,
            "Hooks".into(),
            hooks_hints(state),
        ),
        PanelKind::Diff => menu::OverlayMenu::new_info(
            PanelKind::Diff,
            "Diff".into(),
            vec!["Diff picker lands with session history (spec 008).".into()],
        ),
        PanelKind::Resume => menu::OverlayMenu::new_info(
            PanelKind::Resume,
            "Resume".into(),
            vec!["Session resume lands with persistence (spec 008).".into()],
        ),
        PanelKind::Rewind => menu::OverlayMenu::new_info(
            PanelKind::Rewind,
            "Rewind".into(),
            vec!["/rewind: session-history reset lands in a follow-up change.".into()],
        ),
    };
    state.active_menu = Some(overlay);
    SlashOutcome::Handled
}

fn help_hints() -> Vec<String> {
    vec![
        "otherside cli — offensive-sec operator TUI".into(),
        String::new(),
        "Keys".into(),
        "  Enter      submit turn".into(),
        "  Shift+Enter insert newline".into(),
        "  Tab        autocomplete slash".into(),
        "  Shift+Tab  cycle permission mode".into(),
        "  Esc        cancel current overlay / stream".into(),
        "  Ctrl+C     exit".into(),
        String::new(),
        "Slashes".into(),
        "  type `/` to open the autocomplete popup.".into(),
        "  / then <prefix> filters the catalog.".into(),
    ]
}

fn status_hints(st: &ConversationState) -> Vec<String> {
    vec![
        format!("model: {}", st.model),
        format!("permission: {:?}", st.permission_mode),
        format!(
            "context: {}/{}",
            st.input_tokens,
            st.context_window_label()
        ),
        format!("effort: {}", st.effort_label.unwrap_or("auto")),
        format!(
            "verbose: {}",
            if st.render_verbose { "on" } else { "off" }
        ),
    ]
}

fn config_hints(st: &ConversationState) -> Vec<String> {
    let mut lines = vec![
        format!(
            "default provider: {}",
            st.settings
                .default_provider
                .clone()
                .unwrap_or_else(|| "(unset)".into())
        ),
        format!(
            "default model: {}",
            st.settings
                .default_model
                .clone()
                .unwrap_or_else(|| "(unset)".into())
        ),
        format!(
            "log level: {}",
            st.settings
                .log_level
                .clone()
                .unwrap_or_else(|| "(unset)".into())
        ),
        format!(
            "effort: {}",
            st.settings
                .effort_level
                .clone()
                .unwrap_or_else(|| "(unset)".into())
        ),
        format!(
            "verbose: {}",
            st.settings
                .verbose
                .map(|b| if b { "true".to_string() } else { "false".to_string() })
                .unwrap_or_else(|| "(unset)".into())
        ),
    ];
    if let Some(sl) = st.settings.statusline.as_ref() {
        lines.push(format!("statusline: {:?}", sl));
    }
    lines
}

fn hooks_hints(st: &ConversationState) -> Vec<String> {
    let Some(h) = st.settings.hooks.as_ref() else {
        return vec!["no hooks configured".into()];
    };
    vec![
        format!("pre_tool_use: {}", h.pre_tool_use.len()),
        format!("post_tool_use: {}", h.post_tool_use.len()),
        format!("user_prompt_submit: {}", h.user_prompt_submit.len()),
        format!("stop: {}", h.stop.len()),
    ]
}
