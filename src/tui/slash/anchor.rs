//! Anchor handler — user echo + dim `⎿` system-anchor line.
//!
//! Current slashes: `/branch`, `/compact`, `/context`. Upstream's render
//! format is `❯ /<name> <args>` on one line, then `  ⎿ <result>` on a
//! dim line below. Phase 1 wires the real side-effect for `/compact`
//! (trim history) and stubs `/branch`, `/context` as system notes;
//! phase 5 introduces the formal echo + `⎿` render shape.

use super::super::state::ConversationState;
use super::SlashOutcome;

/// Dispatch an Anchor-category slash. Returns `Handled` — the handler
/// mutates state directly (compact trims history, branch/context emit
/// inline notes until phase 5 wires the formal anchor render).
pub fn handle(name: &str, _args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "compact" => {
            let kept = state.messages.len() as u64;
            state.append_record(crate::sessions::Record::CompactionMark {
                ts: crate::sessions::record::now_iso(),
                summary_ref: format!("kept={kept}"),
            });
            state.compact_history();
            SlashOutcome::Handled
        }
        "branch" => {
            state.push_system_note(
                "/branch: session branch picker lands with persistence (spec 008)".to_string(),
            );
            SlashOutcome::Handled
        }
        "context" => {
            let used = state.input_tokens + state.total_output_tokens();
            let pct = if state.context_window == 0 {
                0
            } else {
                (used.saturating_mul(100) / state.context_window).min(100)
            };
            state.push_system_note(format!(
                "context: {} / {} ({}%)",
                used,
                state.context_window_label(),
                pct
            ));
            SlashOutcome::Handled
        }
        "loop" => {
            state.push_system_note(
                "/loop: loop-mode toggle lands in a follow-up change".to_string(),
            );
            SlashOutcome::Handled
        }
        other => {
            state.push_system_note(format!("unhandled anchor slash: /{other}"));
            SlashOutcome::Handled
        }
    }
}
