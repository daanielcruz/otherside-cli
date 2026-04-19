//! Toggle handler — state flip + ephemeral confirmation in the info row.
//!
//! Phase 1 routed toggles to `push_system_note`; phase 4 wires the
//! 2-column info row + 3s TTL feedback slot so toggles echo in the
//! bottom-left without cluttering the transcript. The inline system
//! note is gone.

use crate::config::settings::PermissionMode;

use super::super::state::ConversationState;
use super::SlashOutcome;

/// Dispatch a Toggle-category slash. Always returns `Handled`.
pub fn handle(name: &str, _args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "plan" => {
            // Flip in/out of plan mode. Shift+Tab still cycles all four
            // permission modes (R-104); /plan is a direct toggle between
            // the current mode and Plan, same as upstream.
            let msg = if matches!(state.permission_mode, PermissionMode::Plan) {
                state.permission_mode = PermissionMode::Default;
                "plan mode off"
            } else {
                state.permission_mode = PermissionMode::Plan;
                "plan mode on"
            };
            state.set_feedback(msg);
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
