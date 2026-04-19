//! Toggle handler — state flip + ephemeral confirmation.
//!
//! Phase 1 routes toggles to existing `ConversationState` mutations and
//! emits the confirmation inline via `push_system_note`. The feedback
//! row (2-column info row, 3s TTL) lands in openspec 001 phase 4 — until
//! then the inline system-note is the user-visible signal.

use super::super::state::ConversationState;
use super::SlashOutcome;

/// Dispatch a Toggle-category slash. Always returns `Handled`.
pub fn handle(name: &str, _args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "plan" => {
            // Real plan-mode flip runs through the Shift+Tab chip cycle
            // (R-104) — this slash surfaces a pointer to that flow until
            // phase 4 wires an inline toggle.
            state.push_system_note(
                "plan mode is cycled with Shift+Tab (Default → AcceptEdits → Plan → Yolo)"
                    .to_string(),
            );
            SlashOutcome::Handled
        }
        "copy" => {
            state.push_system_note(
                "/copy: transcript export to clipboard lands with persistence (spec 008)"
                    .to_string(),
            );
            SlashOutcome::Handled
        }
        "export" => {
            state.push_system_note(
                "/export: transcript export to file lands with persistence (spec 008)".to_string(),
            );
            SlashOutcome::Handled
        }
        "keybindings" => {
            state.push_system_note(
                "keybindings: Enter submit · Shift+Enter newline · Tab autocomplete · Shift+Tab mode · Esc cancel · Ctrl+C exit"
                    .to_string(),
            );
            SlashOutcome::Handled
        }
        "verbose" => {
            let now_on = state.toggle_render_verbose();
            state.push_system_note(format!(
                "verbose render: {}",
                if now_on { "on" } else { "off" }
            ));
            SlashOutcome::Handled
        }
        "sandbox" => {
            state.push_system_note(
                "/sandbox: sandbox isolation is not yet wired (Phase 3 tier)".to_string(),
            );
            SlashOutcome::Handled
        }
        other => {
            state.push_system_note(format!("unhandled toggle slash: /{other}"));
            SlashOutcome::Handled
        }
    }
}
