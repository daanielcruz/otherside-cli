//! Instant handler — silent immediate side-effect. No overlay, no feedback row.
//!
//! Current slashes: `/clear`, `/exit`, `/bye`. Phase 1 routes them to
//! the existing `ConversationState` mutations; `ExitApp` / `Bye` bubble
//! up to the event loop via [`SlashOutcome::ExitApp`] so the caller
//! breaks out of the render loop.

use super::super::state::{ConversationState, DisplayOrigin};
use super::SlashOutcome;

/// Dispatch an Instant-category slash. Returns `ExitApp` for
/// terminators, `Handled` otherwise.
pub fn handle(name: &str, _args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "clear" => {
            state.clear_conversation();
            // Chrome — the `/clear` anchor is a local visual
            // breadcrumb; the history wipe itself is the real effect
            // and already drops prior turns before this push lands.
            state.push_anchor("clear", "", "(no content)", DisplayOrigin::Chrome);
            SlashOutcome::Handled
        }
        "exit" | "bye" => SlashOutcome::ExitApp,
        other => {
            state.push_system_note(format!("unhandled instant slash: /{other}"));
            SlashOutcome::Handled
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_emits_anchor_after_wipe() {
        let mut st = ConversationState::default();
        st.push_system_note("pre-existing note");
        handle("clear", "", &mut st);
        let len = st.messages.len();
        assert_eq!(len, 2, "expected user-echo + anchor after clear");
        assert_eq!(st.messages[len - 2].content, "/clear");
        assert_eq!(st.messages[len - 1].content, "⎿  (no content)");
    }
}
