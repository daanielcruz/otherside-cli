//! Agent loop — conversation state + multi-turn orchestration.
//!
//! This module owns the "send request → receive response with possible
//! tool_use blocks → run tools → feed results back" loop. It does NOT
//! own provider dispatch (that's `provider::*`) or tool implementations
//! (that's `tools::*`) — it wires them together.
//!
//! # State today
//!
//! Types + builder live here. The full orchestration (drive the stream,
//! accumulate tool_use deltas, dispatch on completion, re-invoke) is
//! paired with the translator's tool_use extensions — both land in the
//! same follow-up push once the wire is complete.

use std::collections::HashMap;

use crate::inference::OpenAiChatMessage;

/// One turn of the conversation — the outbound request's snapshot.
#[derive(Debug, Clone, Default)]
pub struct Turn {
    pub messages: Vec<OpenAiChatMessage>,
    /// Arguments accumulated per tool-call index during streaming.
    /// Populated by the SSE consumer as `input_json_delta` events
    /// arrive; drained when a `content_block_stop` fires for a
    /// `tool_use` block.
    pub tool_arg_buffer: HashMap<u32, String>,
}

/// Hard cap on auto-turns before the loop yields control back to the
/// user. Mirrors upstream's limit. Exposed so it can be lowered via
/// settings when the model gets looped on a non-terminating task.
pub const MAX_AUTO_TURNS: u32 = 25;

impl Turn {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, msg: OpenAiChatMessage) {
        self.messages.push(msg);
    }

    pub fn last_role(&self) -> Option<crate::inference::OpenAiChatRole> {
        self.messages.last().map(|m| m.role)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::OpenAiChatRole;

    #[test]
    fn turn_push_and_last_role() {
        let mut t = Turn::new();
        assert!(t.last_role().is_none());
        t.push(OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: "hi".into(),
            ..Default::default()
        });
        assert_eq!(t.last_role(), Some(OpenAiChatRole::User));
    }

    #[test]
    fn max_auto_turns_sensible() {
        assert!(MAX_AUTO_TURNS > 1);
        assert!(MAX_AUTO_TURNS <= 100);
    }
}
