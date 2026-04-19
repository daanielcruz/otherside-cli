//! Toggle handler — state flip + ephemeral confirmation in the info row.
//!
//! Phase 1 routed toggles to `push_system_note`; phase 4 wires the
//! 2-column info row + 3s TTL feedback slot so toggles echo in the
//! bottom-left without cluttering the transcript. The inline system
//! note is gone.

use super::super::state::ConversationState;
use super::SlashOutcome;

/// Dispatch a Toggle-category slash. Always returns `Handled`.
pub fn handle(name: &str, _args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "plan" => {
            // Plan mode is authoritatively cycled via Shift+Tab
            // (R-104); `/plan` surfaces a hint pointing at the chip
            // cycle until a dedicated in-slash toggle lands.
            state.set_feedback("plan mode — cycle with Shift+Tab");
        }
        "tag" => {
            state.set_feedback("/tag: turn tagging lands with persistence (spec 008)");
        }
        "copy" => {
            state.set_feedback("/copy: clipboard export lands with persistence (spec 008)");
        }
        "export" => {
            state.set_feedback("/export: transcript export lands with persistence (spec 008)");
        }
        "keybindings" => {
            state.set_feedback(
                "keys: Enter · Shift+Enter · Tab · Shift+Tab · Esc · Ctrl+C",
            );
        }
        other => {
            state.set_feedback(format!("unhandled toggle slash: /{other}"));
        }
    }
    SlashOutcome::Handled
}
