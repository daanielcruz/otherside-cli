//! Anchor handler — user echo + dim `⎿` result line.
//!
//! Render shape (openspec 001 phase 5):
//!
//! ```text
//! ❯ /compact
//!   ⎿ context compacted: 42 msgs → 3 msgs
//! ```
//!
//! The user-echo row rides the normal User render path (chevron). The
//! `⎿` row is a System message prefixed with `⎿ ` — the render layer
//! spots the prefix and drops the usual `system:` label, painting
//! the line muted + italic with a 2-space left pad.
//!
//! Per-slash result string:
//!
//! - `/compact` runs `state.compact_history()` and reports the dropped
//!   message count.
//! - `/branch` is a placeholder until session persistence (spec 008).
//! - `/context` computes a live usage snapshot.
//! - `/loop` is a placeholder; loop-mode toggle lives at the /loop
//!   skill layer today.

use super::super::state::ConversationState;
use super::SlashOutcome;

/// Dispatch an Anchor-category slash. Returns `Handled` — the handler
/// mutates state directly (push_anchor appends the echo + result
/// lines to the transcript).
pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    let lower = name.to_ascii_lowercase();
    // `/compact` emits a 3-line block (upstream parity, openspec 002):
    //   ✻ Conversation compacted (ctrl+o for history)
    //   ❯ /compact
    //     ⎿ Compacted (ctrl+o to see full summary)
    // Order is strict: header push, then compact side-effect, then
    // anchor pair. The header lands as a pre-existing message that
    // survives the `compact_history` wipe — it's pushed AFTER the
    // wipe so the user sees it at the top of the new transcript.
    if lower.as_str() == "compact" {
        run_compact(state);
        state.push_system_note("✻ Conversation compacted (ctrl+o for history)");
        state.push_anchor(&lower, args, "Compacted (ctrl+o to see full summary)");
        return SlashOutcome::Handled;
    }
    let result = match lower.as_str() {
        "branch" => {
            "session branch lands with persistence (spec 008)".to_string()
        }
        "context" => context_result(state),
        "loop" => {
            "loop mode toggle lands in a follow-up change".to_string()
        }
        other => format!("unhandled anchor slash: /{other}"),
    };
    state.push_anchor(&lower, args, result);
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
    let used = state.input_tokens + state.total_output_tokens();
    let pct = if state.context_window == 0 {
        0
    } else {
        (used.saturating_mul(100) / state.context_window).min(100)
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
        // After compact_history wipes the transcript, the handler
        // pushes: [✻ header, /compact echo, ⎿ anchor] → 3 messages.
        assert_eq!(st.messages.len(), 3);
        assert_eq!(
            st.messages[0].content,
            "✻ Conversation compacted (ctrl+o for history)"
        );
        assert_eq!(st.messages[1].content, "/compact");
        assert_eq!(
            st.messages[2].content,
            "⎿ Compacted (ctrl+o to see full summary)"
        );
    }

    #[test]
    fn compact_anchor_body_matches_upstream() {
        let mut st = ConversationState::default();
        handle("compact", "", &mut st);
        let last = st.messages.last().unwrap();
        assert_eq!(last.content, "⎿ Compacted (ctrl+o to see full summary)");
        assert!(!last.content.contains("dropped"));
        assert!(!last.content.contains("prior message"));
    }
}
