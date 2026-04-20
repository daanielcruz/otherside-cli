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
        PanelKind::Model => {
            // Surface the session's effort level to the picker so
            // upstream's inline `◉ {Level} effort (default) ← → to adjust`
            // indicator renders (014 parity). Defaults to `xhigh`
            // when unset — upstream Opus default.
            let effort = state.effort_label.unwrap_or("xhigh");
            menu::OverlayMenu::new_model_with_effort(&state.model, Some(effort))
        }
        PanelKind::Help => menu::OverlayMenu::new_info(
            PanelKind::Help,
            "Slash commands".into(),
            help_hints(),
        ),
        // Unified Settings panel — `/status`, `/config`, `/usage`
        // collapse into one `PanelKind::Settings(tab)` per upstream
        // `components/Settings/Settings.tsx` (008 evidence). Title,
        // content body, and focus-initial depend on the default tab;
        // the dismiss anchor is hardcoded `Status dialog dismissed`
        // regardless of tab (see `emit_panel_dismiss_anchor`).
        PanelKind::Settings(tab) => menu::OverlayMenu::new_settings(tab, state),
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
    use super::catalog::{CATALOG, SlashKind};
    let mut lines = vec![
        format!("otherside cli v{}", env!("CARGO_PKG_VERSION")),
        String::new(),
        "Shortcuts".into(),
        "  Enter          submit turn               Shift+Enter   newline".into(),
        "  Tab            autocomplete slash        Shift+Tab     cycle permission mode".into(),
        "  ↑ / ↓          input history             Shift+↑/↓     scroll log one line".into(),
        "  PgUp / PgDn    scroll log ± 10 lines     Ctrl+Home/End jump top / bottom".into(),
        "  Esc            cancel overlay / stream   Ctrl+U        kill input line".into(),
        "  Ctrl+C         arm exit (2× to quit)     Ctrl+D        exit when input empty".into(),
        "  !              bash passthrough line".into(),
        String::new(),
        "Slash commands".into(),
    ];
    // Group by category; two columns per row for density.
    for kind in [
        SlashKind::Instant,
        SlashKind::Toggle,
        SlashKind::Skill,
        SlashKind::Anchor,
        SlashKind::Auth,
    ] {
        let slashes: Vec<&str> = CATALOG
            .iter()
            .filter(|e| matches!(e.kind, ref k if std::mem::discriminant(k) == std::mem::discriminant(&kind)))
            .map(|e| e.name)
            .collect();
        if slashes.is_empty() {
            continue;
        }
        let label = match kind {
            SlashKind::Instant => "instant",
            SlashKind::Toggle => "toggle",
            SlashKind::Skill => "skill",
            SlashKind::Anchor => "anchor",
            SlashKind::Panel(_) => "panel",
            SlashKind::Auth => "auth",
        };
        lines.push(format!(
            "  {label:<8}  /{}",
            slashes.join(" /")
        ));
    }
    // Panel group separately since its discriminant carries data.
    let panel_names: Vec<&str> = CATALOG
        .iter()
        .filter(|e| matches!(e.kind, SlashKind::Panel(_)))
        .map(|e| e.name)
        .collect();
    if !panel_names.is_empty() {
        lines.push(format!("  panel     /{}", panel_names.join(" /")));
    }
    lines.push(String::new());
    lines.push("Type `/` to filter. Type `/<prefix>` to narrow.".into());
    lines
}

// Settings panel rows (Status / Config / Usage tabs) live in
// `tui::menu::new_settings` now — 009 moved them there so interactive
// editing (bool toggle, enum cycle, provider switch) can read the
// row's `SettingsRowKind` directly.

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
