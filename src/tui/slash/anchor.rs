

use super::super::state::{ConversationState, DisplayOrigin};
use super::SlashOutcome;

pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    let lower = name.to_ascii_lowercase();

    if lower.as_str() == "compact" {
        run_compact(state);

        state.push_system_note("✻ Conversation compacted (ctrl+o for history)");
        state.push_anchor(
            &lower,
            args,
            "Compacted (ctrl+o to see full summary)",
            DisplayOrigin::Transcript,
        );
        return SlashOutcome::Handled;
    }
    let result = match lower.as_str() {
        "branch" => {
            "session branch lands with persistence (spec 008)".to_string()
        }
        "context" => context_result(state),
        other => format!("unhandled anchor slash: /{other}"),
    };

    let origin = match lower.as_str() {
        "branch" => DisplayOrigin::Chrome,
        _ => DisplayOrigin::Transcript,
    };
    state.push_anchor(&lower, args, result, origin);
    SlashOutcome::Handled
}

fn run_compact(state: &mut ConversationState) {
    let kept = state.messages.len() as u64;
    state.append_record(crate::sessions::Record::CompactionMark {
        ts: crate::sessions::record::now_iso(),
        summary_ref: format!("kept={kept}"),
    });
    state.compact_history();
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
    fn compact_emits_star_header_before_anchor() {
        let mut st = ConversationState::default();
        handle("compact", "", &mut st);

        assert_eq!(st.messages.len(), 3);
        assert_eq!(
            st.messages[0].content,
            "✻ Conversation compacted (ctrl+o for history)"
        );
        assert_eq!(st.messages[1].content, "/compact");
        assert_eq!(
            st.messages[2].content,
            "⎿  Compacted (ctrl+o to see full summary)"
        );
    }

    #[test]
    fn compact_anchor_body_matches_upstream() {
        let mut st = ConversationState::default();
        handle("compact", "", &mut st);
        let last = st.messages.last().unwrap();
        assert_eq!(last.content, "⎿  Compacted (ctrl+o to see full summary)");
        assert!(!last.content.contains("dropped"));
        assert!(!last.content.contains("prior message"));
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
            !dump.contains("session branch") && !dump.contains("/branch"),
            "branch anchor text leaked into history_for_request: {dump}",
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

    #[test]
    fn compact_anchor_rows_remain_transcript() {
        let mut st = ConversationState::default();
        handle("compact", "", &mut st);

        assert_eq!(st.messages.len(), 3);
        assert_eq!(st.messages[0].origin, DisplayOrigin::Chrome);
        assert_eq!(st.messages[1].origin, DisplayOrigin::Transcript);
        assert_eq!(st.messages[2].origin, DisplayOrigin::Transcript);
    }
}
