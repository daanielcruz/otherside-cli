
use super::super::state::{ConversationState, DisplayOrigin};
use super::SlashOutcome;

pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    let lower = name.to_ascii_lowercase();

    let result = match lower.as_str() {
        "branch" => {
            "session fork is not implemented — requires transcript persistence".to_string()
        }
        "context" => context_result(state),
        "compact" => {
            "internal: /compact reached anchor::handle — dispatch_slash intercept missing".to_string()
        }
        other => format!("unhandled anchor slash: /{other}"),
    };

    let origin = match lower.as_str() {
        "branch" | "compact" => DisplayOrigin::Chrome,
        _ => DisplayOrigin::Transcript,
    };
    state.push_anchor(&lower, args, result, origin);
    SlashOutcome::Handled
}

fn context_result(state: &ConversationState) -> String {

    let used = state.input_tokens + state.output_tokens;
    let pct = if state.session.context_window == 0 {
        0
    } else {
        (used.saturating_mul(100) / state.session.context_window).min(100)
    };
    format!("{} / {} ({}%)", used, state.context_window_label(), pct)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_falls_through_to_error_when_dispatch_intercept_missing() {
        
        let mut st = ConversationState::default();
        handle("compact", "", &mut st);
        let last = st.messages.last().unwrap();
        assert!(
            last.content.contains("dispatch_slash intercept missing"),
            "expected loud fallback error, got {:?}",
            last.content,
        );
    }

    #[test]
    fn branch_anchor_marks_both_rows_as_chrome() {
        let mut st = ConversationState::default();
        handle("branch", "", &mut st);
        assert_eq!(st.messages.len(), 2, "branch anchor emits echo + ⎿ row");
        assert_eq!(
            st.messages[0].origin,
            DisplayOrigin::Chrome,
            "/branch echo must be Chrome (display: 'system')"
        );
        assert_eq!(
            st.messages[1].origin,
            DisplayOrigin::Chrome,
            "/branch ⎿ result must be Chrome (display: 'system')"
        );
    }

    #[test]
    fn branch_anchor_absent_from_history_for_request() {
        let mut st = ConversationState::default();
        handle("branch", "", &mut st);
        let hist = st.history_for_request();
        let dump = format!("{hist:?}");
        assert!(
            !dump.contains("session fork") && !dump.contains("/branch"),
            "branch anchor text leaked into history_for_request: {dump}",
        );
    }

    #[test]
    fn branch_anchor_is_honest_about_not_being_implemented() {
        let mut st = ConversationState::default();
        handle("branch", "", &mut st);
        let last = st.messages.last().unwrap();
        assert!(
            last.content.contains("not implemented"),
            "the /branch anchor must tell the user the feature is not implemented, not ship an internal spec reference: got {}",
            last.content
        );
    }

    #[test]
    fn context_anchor_stays_transcript_pending_capture() {
        let mut st = ConversationState::default();
        handle("context", "", &mut st);
        assert_eq!(st.messages.len(), 2);
        assert_eq!(st.messages[0].origin, DisplayOrigin::Transcript);
        assert_eq!(st.messages[1].origin, DisplayOrigin::Transcript);
    }

}
