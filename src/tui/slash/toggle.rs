

use crate::config::settings::PermissionMode;

use super::super::state::{ConversationState, DisplayOrigin};
use super::SlashOutcome;

pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "plan" => {

            let anchor_result = if matches!(state.session.permission_mode, PermissionMode::Plan) {
                state.session.permission_mode = PermissionMode::Default;
                "Disabled plan mode"
            } else {
                state.session.permission_mode = PermissionMode::Plan;
                "Enabled plan mode"
            };

            state.push_anchor("plan", args, anchor_result, DisplayOrigin::Chrome);
        }
        "copy" => {
            state.set_feedback("/copy: not implemented — clipboard export not wired yet");
        }
        "export" => {
            state.set_feedback("/export: not implemented — transcript export not wired yet");
        }
        other => {
            state.set_feedback(format!("unhandled toggle slash: /{other}"));
        }
    }
    SlashOutcome::Handled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_anchor_enabled_wording() {
        let mut st = ConversationState::default();
        assert!(!matches!(st.session.permission_mode, PermissionMode::Plan));
        handle("plan", "", &mut st);

        let len = st.messages.len();
        assert!(len >= 2);
        assert_eq!(st.messages[len - 2].content, "/plan");
        assert_eq!(st.messages[len - 1].content, "⎿  Enabled plan mode");
        assert!(matches!(st.session.permission_mode, PermissionMode::Plan));
    }

    #[test]
    fn plan_anchor_disabled_wording() {
        let mut st = ConversationState::default();
        st.session.permission_mode = PermissionMode::Plan;
        handle("plan", "", &mut st);
        let len = st.messages.len();
        assert!(st.messages[len - 1].content.ends_with("Disabled plan mode"));
        assert!(matches!(st.session.permission_mode, PermissionMode::Default));
    }

    #[test]
    fn plan_does_not_set_ephemeral_feedback() {

        let mut st = ConversationState::default();
        handle("plan", "", &mut st);
        assert!(st.toggle_feedback.is_none());
    }
}
