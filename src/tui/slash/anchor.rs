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
    let result = match lower.as_str() {
        "compact" => compact_result(state),
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

fn compact_result(state: &mut ConversationState) -> String {
    let kept = state.messages.len() as u64;
    state.append_record(crate::sessions::Record::CompactionMark {
        ts: crate::sessions::record::now_iso(),
        summary_ref: format!("kept={kept}"),
    });
    // compact_history clears the transcript; we want the anchor to
    // land AFTER, so capture the count first and let push_anchor
    // append to the now-empty history.
    state.compact_history();
    format!("compacted: {kept} prior message{} dropped", if kept == 1 { "" } else { "s" })
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
