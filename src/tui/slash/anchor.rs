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
//!
//! openspec 011 moved `/loop` out of this module — upstream classifies
//! it as a bundled skill, not an anchor. It now dispatches through
//! `skill::handle`.

use super::super::state::{ConversationState, DisplayOrigin};
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
        // ✻ marker is chrome (`push_system_note` stamps Chrome by
        // default) — it's a visual reminder of the compaction, not a
        // conversation turn. The `/compact` anchor pair below IS
        // Transcript: the summary semantics belong in the wire.
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
    // Origin classification per upstream `display:` flag (openspec 012):
    //
    // - `/branch` → Chrome. Upstream `commands/branch/branch.ts:281`
    //   fires `onDone(successMessage, { display: 'system' })`, which
    //   routes through `processSlashCommand.tsx:603` to
    //   `createCommandInputMessage` (type:`system`, subtype:
    //   `local_command`) — filtered before wire. Pushing the
    //   placeholder as Transcript would leak it into
    //   `/v1/messages` on the next user turn.
    // - `/context` → Transcript (pending). 2.1.88
    //   `commands/context/context.tsx:61` calls `onDone(output)` with
    //   no second argument — the non-system-display branch in
    //   `processSlashCommand.tsx:603` serializes it as a user message.
    //   2.1.101..2.1.114 have the interactive file DCE'd; no live
    //   tmux capture of 2.1.114's `/context` dismiss exists. Holding
    //   at Transcript until that capture lands (openspec 012 § Out-of-scope).
    // - default fallback → Transcript. An unhandled anchor slash is
    //   a bug; keeping it on-wire makes the failure visible.
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

    /// R-92 (openspec 012): `/branch` both rows must carry
    /// `DisplayOrigin::Chrome`. Upstream evidence:
    /// `reconstructed/2.1.113/source/commands/branch/branch.ts:281`
    /// (`onDone(successMessage, { display: 'system' })`).
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

    /// Task gate (openspec 012): `/branch` placeholder must NOT
    /// appear in `history_for_request` — that's the wire leak the
    /// change closes.
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

    /// Deferred per 012 § Out-of-scope — 2.1.88 source shows
    /// `onDone(output)` bare, 2.1.101..2.1.114 DCE'd, no live capture.
    /// Lock current behavior until a follow-up change lands with
    /// primary-source evidence against 2.1.114.
    #[test]
    fn context_anchor_stays_transcript_pending_capture() {
        let mut st = ConversationState::default();
        handle("context", "", &mut st);
        assert_eq!(st.messages.len(), 2);
        assert_eq!(st.messages[0].origin, DisplayOrigin::Transcript);
        assert_eq!(st.messages[1].origin, DisplayOrigin::Transcript);
    }

    /// Regression guard for the catch-all default branch — ensure the
    /// per-slash match in `handle` did not accidentally flip
    /// `/compact`'s anchor pair off Transcript (it's a real wire event
    /// — the `{type:'compact'}` summary is serialized intentionally).
    #[test]
    fn compact_anchor_rows_remain_transcript() {
        let mut st = ConversationState::default();
        handle("compact", "", &mut st);
        // messages[0] is the `✻` header (Chrome via push_system_note).
        // messages[1] + [2] are the anchor pair — both must be Transcript.
        assert_eq!(st.messages.len(), 3);
        assert_eq!(st.messages[0].origin, DisplayOrigin::Chrome);
        assert_eq!(st.messages[1].origin, DisplayOrigin::Transcript);
        assert_eq!(st.messages[2].origin, DisplayOrigin::Transcript);
    }
}
