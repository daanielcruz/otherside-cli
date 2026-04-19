//! Instant handler — silent immediate side-effect. No overlay, no feedback row.
//!
//! Current slashes: `/clear`, `/exit`, `/bye`. Phase 1 routes them to
//! the existing `ConversationState` mutations; `ExitApp` / `Bye` bubble
//! up to the event loop via [`SlashOutcome::ExitApp`] so the caller
//! breaks out of the render loop.

use super::super::state::ConversationState;
use super::SlashOutcome;

/// Dispatch an Instant-category slash. Returns `ExitApp` for
/// terminators, `Handled` otherwise.
pub fn handle(name: &str, _args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "clear" => {
            state.clear_conversation();
            SlashOutcome::Handled
        }
        "exit" | "bye" => SlashOutcome::ExitApp,
        other => {
            state.push_system_note(format!("unhandled instant slash: /{other}"));
            SlashOutcome::Handled
        }
    }
}
