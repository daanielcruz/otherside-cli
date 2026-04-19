//! Skill handler — bundled SKILL.md body becomes a user turn.
//!
//! Phase 1 forwards the raw slash (`/<name> <args>`) as a user turn; the
//! LLM treats it like any other message. Phase 6 wires the bundled
//! `skills/<name>/SKILL.md` bodies so the handler emits `<body>\n\n<args>`
//! instead of the raw slash — which is how upstream's `type: 'prompt'`
//! commands work with their loaded skill catalog.

use super::super::state::ConversationState;
use super::SlashOutcome;

/// Dispatch a Skill-category slash. Returns `SendTurn(raw)` so the
/// event loop submits it to the provider.
pub fn handle(name: &str, args: &str, _state: &mut ConversationState) -> SlashOutcome {
    let user_turn = if args.is_empty() {
        format!("/{name}")
    } else {
        format!("/{name} {args}")
    };
    SlashOutcome::SendTurn(user_turn)
}
