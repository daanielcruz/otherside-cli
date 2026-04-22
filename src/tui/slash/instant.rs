

use super::super::state::{ConversationState, DisplayOrigin};
use super::SlashOutcome;

pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    let _ = args;
    match name.to_ascii_lowercase().as_str() {
        "clear" => {
            state.clear_conversation();

            state.push_anchor("clear", "", "(no content)", DisplayOrigin::Chrome);
            SlashOutcome::Handled
        }
        "exit" => SlashOutcome::ExitApp,
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
