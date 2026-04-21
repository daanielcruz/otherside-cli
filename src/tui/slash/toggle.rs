//! Toggle handler — state flip + ephemeral confirmation in the info row.
//!
//! Phase 1 routed toggles to `push_system_note`; phase 4 wires the
//! 2-column info row + 3s TTL feedback slot so toggles echo in the
//! bottom-left without cluttering the transcript. The inline system
//! note is gone.

use crate::config::settings::PermissionMode;

use super::super::state::{ConversationState, DisplayOrigin};
use super::SlashOutcome;

/// Dispatch a Toggle-category slash. Always returns `Handled`.
pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "plan" => {
            // Flip in/out of plan mode. Shift+Tab still cycles all four
            // permission modes (R-104); /plan is a direct toggle between
            // the current mode and Plan, same as upstream.
            //
            // Do NOT set_feedback here — the ephemeral "plan mode on"
            // text would hide the persistent `⏸ plan mode on
            // (shift+tab to cycle)` chip in the info-row left slot.
            // Upstream uses only the persistent chip; we do the same.
            // The scrollback anchor below carries the transient
            // confirmation.
            let anchor_result = if matches!(state.session.permission_mode, PermissionMode::Plan) {
                state.session.permission_mode = PermissionMode::Default;
                "Disabled plan mode"
            } else {
                state.session.permission_mode = PermissionMode::Plan;
                "Enabled plan mode"
            };
            // Chrome — plan-mode toggle is a local permission flip.
            // Upstream never round-trips this to the provider.
            state.push_anchor("plan", args, anchor_result, DisplayOrigin::Chrome);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_anchor_enabled_wording() {
        let mut st = ConversationState::default();
        assert!(!matches!(st.session.permission_mode, PermissionMode::Plan));
        handle("plan", "", &mut st);
        // push_anchor appends [user-echo, `⎿ <result>`] at the tail.
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
        // Chip path owns plan-mode signal (`⏸ plan mode on
        // (shift+tab to cycle)`) persistently; an ephemeral "plan
        // mode on" feedback would hide it for 3s.
        let mut st = ConversationState::default();
        handle("plan", "", &mut st);
        assert!(st.toggle_feedback.is_none());
    }
}
