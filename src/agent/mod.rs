//! Agent loop — conversation state + multi-turn orchestration.
//!
//! Owns the "send request → stream back → accumulate tool_use blocks
//! → dispatch tools → build tool results → feed back into next turn"
//! cycle. Does NOT own provider dispatch (`provider::*`) or tool
//! implementations (`tools::*`) — it wires them together.
//!
//! # Turn lifecycle
//!
//! 1. Caller prepares the initial `Vec<OpenAiChatMessage>` (the user
//!    turn and any prior history) and hands it to [`AgentLoop::run`].
//! 2. Loop dispatches the provider stream, folding each
//!    [`OpenAiChunk`] through [`TurnState::fold_chunk`]: text deltas
//!    accumulate into the assistant buffer; tool_call deltas
//!    accumulate per index into a pending-call table.
//! 3. When the stream closes with `finish_reason = "tool_calls"`, the
//!    loop drains pending calls, dispatches each via
//!    [`tools::dispatch`], packages each result as a `role = "tool"`
//!    message, appends everything (assistant + tools) to the history,
//!    and starts another turn.
//! 4. Any other `finish_reason` (or reaching [`MAX_AUTO_TURNS`])
//!    terminates the loop; final history is returned to the caller.
//!
//! # Determinism
//!
//! Tool ordering: the loop dispatches in ascending call index, which
//! matches both the stream arrival order and the order the model
//! intended. Results go into the next turn's history in the same order.
//!
//! # TUI plumbing
//!
//! The TUI event loop owns the display-side of tool calls; it feeds
//! the accumulated deltas into `tui::tool_render` to paint the
//! `⏺ ToolName ⎿ …` shape while the agent loop runs underneath.

use std::collections::HashMap;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::inference::{
    OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole, OpenAiChunk, OpenAiToolCall,
    OpenAiToolCallDelta, OpenAiToolCallFunction,
};
use crate::provider::{ChunkStream, Provider};
use crate::thinking::ThinkingConfig;
use crate::tools;

/// Hard cap on auto-turns before the loop yields control back to the
/// user. Mirrors upstream. Exposed so it can be lowered via settings
/// when the model gets looped on a non-terminating task.
pub const MAX_AUTO_TURNS: u32 = 25;

/// One turn's worth of accumulation state — deltas-to-full.
///
/// Reset between turns. `fold_chunk` is the only mutator and is
/// expected to be called once per [`OpenAiChunk`] from the stream.
#[derive(Debug, Clone, Default)]
pub struct Turn {
    /// Text content accumulated from `delta.content` fragments.
    pub assistant_text: String,
    /// Tool-call fragments keyed by OpenAI `index`. Every delta
    /// concatenates into the matching entry.
    pub tool_calls: HashMap<u32, PendingToolCall>,
    /// Final `finish_reason` once the stream closes. `None` while
    /// streaming.
    pub finish_reason: Option<String>,
}

/// Accumulator for a single tool call across streaming deltas.
#[derive(Debug, Clone, Default)]
pub struct PendingToolCall {
    pub id: Option<String>,
    pub name: Option<String>,
    pub args_buffer: String,
}

impl PendingToolCall {
    /// Merge a delta's fragment into this accumulator.
    pub fn merge(&mut self, delta: &OpenAiToolCallDelta) {
        if let Some(id) = &delta.id {
            self.id = Some(id.clone());
        }
        if let Some(f) = &delta.function {
            if let Some(name) = &f.name {
                // Last name wins — the first fragment carries the name
                // and subsequent ones usually omit it, but tolerate a
                // server that repeats.
                self.name = Some(name.clone());
            }
            if let Some(args) = &f.arguments {
                self.args_buffer.push_str(args);
            }
        }
    }

    /// Freeze into a complete [`OpenAiToolCall`]. Returns `None` if
    /// `id` or `name` were never seen — those are required and a
    /// missing value means the translator gave us a malformed stream.
    pub fn finalize(self) -> Option<OpenAiToolCall> {
        Some(OpenAiToolCall {
            id: self.id?,
            kind: "function".to_string(),
            function: OpenAiToolCallFunction {
                name: self.name?,
                arguments: self.args_buffer,
            },
        })
    }
}

impl Turn {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one chunk into this turn's accumulators. Returns the text
    /// delta (if any) so the caller can stream it to the UI — the
    /// accumulators themselves are internal state.
    pub fn fold_chunk(&mut self, chunk: OpenAiChunk) -> Option<String> {
        let choice = chunk.choices.into_iter().next()?;
        if let Some(reason) = choice.finish_reason {
            self.finish_reason = Some(reason);
        }
        let delta = choice.delta;
        let mut emitted: Option<String> = None;
        if let Some(text) = delta.content {
            if !text.is_empty() {
                self.assistant_text.push_str(&text);
                emitted = Some(text);
            }
        }
        for tc in delta.tool_calls {
            let entry = self.tool_calls.entry(tc.index).or_default();
            entry.merge(&tc);
        }
        emitted
    }

    /// Drain tool calls in ascending index order. Non-finalizable
    /// entries (missing id/name) are dropped — that's a translator
    /// bug, not a dispatch concern.
    pub fn drain_calls(&mut self) -> Vec<OpenAiToolCall> {
        let mut indices: Vec<u32> = self.tool_calls.keys().copied().collect();
        indices.sort_unstable();
        let mut out = Vec::with_capacity(indices.len());
        for i in indices {
            if let Some(pending) = self.tool_calls.remove(&i) {
                if let Some(finalized) = pending.finalize() {
                    out.push(finalized);
                }
            }
        }
        out
    }

    pub fn has_pending_calls(&self) -> bool {
        !self.tool_calls.is_empty()
    }

    pub fn wants_tool_dispatch(&self) -> bool {
        matches!(self.finish_reason.as_deref(), Some("tool_calls"))
    }
}

/// Trait-abstracted tool executor so tests can inject deterministic
/// fakes without touching the filesystem.
pub trait ToolDispatcher {
    fn dispatch(&self, name: &str, args: &Value) -> Result<Value>;
}

/// Default executor — thin wrapper over `tools::dispatch`.
#[derive(Debug, Default)]
pub struct DefaultToolDispatcher;

impl ToolDispatcher for DefaultToolDispatcher {
    fn dispatch(&self, name: &str, args: &Value) -> Result<Value> {
        tools::dispatch(name, args).map_err(|e| Error::Other(format!("tool `{name}`: {e}")))
    }
}

/// Build the `role = "tool"` message for a dispatched call.
pub fn tool_result_message(call_id: &str, result: &Value) -> OpenAiChatMessage {
    OpenAiChatMessage {
        role: OpenAiChatRole::Tool,
        content: serde_json::to_string(result).unwrap_or_else(|_| result.to_string()),
        name: None,
        tool_calls: Vec::new(),
        tool_call_id: Some(call_id.to_string()),
    }
}

/// Orchestrator — holds the provider + model config between turns so
/// the caller can run a multi-turn cycle with a single call.
pub struct AgentLoop<D: ToolDispatcher> {
    pub model: String,
    pub thinking: Option<ThinkingConfig>,
    pub max_turns: u32,
    pub dispatcher: D,
}

/// Output of a full loop — the assistant-facing history plus a
/// summary so the caller can decide whether to show "hit auto limit".
#[derive(Debug, Default)]
pub struct LoopResult {
    /// Messages to display / persist. Starts with the caller-provided
    /// history; every assistant message (plus tool results) appended.
    pub history: Vec<OpenAiChatMessage>,
    /// Number of turns taken.
    pub turns: u32,
    /// `true` if the loop exited because [`AgentLoop::max_turns`] was
    /// reached before the model asked to stop. The caller typically
    /// surfaces a system note in the TUI.
    pub hit_turn_limit: bool,
}

impl<D: ToolDispatcher> AgentLoop<D> {
    /// Drive the cycle. `initial` is the full starting history; it's
    /// taken into the returned `LoopResult.history` as the prefix.
    pub async fn run<F, Fut>(
        &self,
        initial: Vec<OpenAiChatMessage>,
        mut stream_fn: F,
    ) -> Result<LoopResult>
    where
        F: FnMut(OpenAiChatRequest, Option<ThinkingConfig>) -> Fut,
        Fut: std::future::Future<Output = Result<ChunkStream>>,
    {
        use futures::StreamExt;

        let mut history = initial;
        let mut turns = 0u32;

        while turns < self.max_turns {
            turns += 1;
            let req = OpenAiChatRequest {
                model: self.model.clone(),
                messages: history.clone(),
                stream: Some(true),
                ..Default::default()
            };
            let mut stream = stream_fn(req, self.thinking).await?;
            let mut turn = Turn::new();
            while let Some(item) = stream.next().await {
                let chunk = item?;
                let _ = turn.fold_chunk(chunk);
            }

            if turn.wants_tool_dispatch() && turn.has_pending_calls() {
                let tool_calls = turn.drain_calls();
                let assistant_msg = OpenAiChatMessage {
                    role: OpenAiChatRole::Assistant,
                    content: turn.assistant_text.clone(),
                    name: None,
                    tool_calls: tool_calls.clone(),
                    tool_call_id: None,
                };
                history.push(assistant_msg);
                for call in &tool_calls {
                    let args_value: Value = serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| Value::String(call.function.arguments.clone()));
                    let result = match self.dispatcher.dispatch(&call.function.name, &args_value) {
                        Ok(v) => v,
                        Err(e) => Value::String(format!("tool error: {e}")),
                    };
                    history.push(tool_result_message(&call.id, &result));
                }
                continue;
            }

            // No tools — final assistant turn. Append and stop.
            if !turn.assistant_text.is_empty() {
                history.push(OpenAiChatMessage {
                    role: OpenAiChatRole::Assistant,
                    content: turn.assistant_text,
                    name: None,
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
            }
            return Ok(LoopResult {
                history,
                turns,
                hit_turn_limit: false,
            });
        }

        Ok(LoopResult {
            history,
            turns,
            hit_turn_limit: true,
        })
    }
}

/// Convenience: build an `AgentLoop` that uses a provider's stream
/// function directly.
pub async fn run_with_provider<P: Provider + ?Sized>(
    provider: &P,
    model: String,
    thinking: Option<ThinkingConfig>,
    history: Vec<OpenAiChatMessage>,
) -> Result<LoopResult> {
    let loop_ = AgentLoop {
        model,
        thinking,
        max_turns: MAX_AUTO_TURNS,
        dispatcher: DefaultToolDispatcher,
    };
    loop_
        .run(history, |req, thinking_cfg| async move {
            provider.stream(req, thinking_cfg).await
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::{
        OpenAiChoice, OpenAiDelta, OpenAiToolCallDelta, OpenAiToolCallFunctionDelta,
    };
    use futures::stream;
    use serde_json::json;

    fn text_chunk(text: &str, finish: Option<&str>) -> OpenAiChunk {
        OpenAiChunk {
            id: "chatcmpl-t".into(),
            object: OpenAiChunk::OBJECT.into(),
            created: 0,
            model: "m".into(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    role: None,
                    content: Some(text.to_string()),
                    tool_calls: Vec::new(),
                },
                finish_reason: finish.map(|s| s.to_string()),
            }],
        }
    }

    fn tool_chunk(index: u32, delta: OpenAiToolCallDelta, finish: Option<&str>) -> OpenAiChunk {
        OpenAiChunk {
            id: "chatcmpl-t".into(),
            object: OpenAiChunk::OBJECT.into(),
            created: 0,
            model: "m".into(),
            choices: vec![OpenAiChoice {
                index,
                delta: OpenAiDelta {
                    role: None,
                    content: None,
                    tool_calls: vec![delta],
                },
                finish_reason: finish.map(|s| s.to_string()),
            }],
        }
    }

    #[test]
    fn fold_chunk_accumulates_text() {
        let mut t = Turn::new();
        t.fold_chunk(text_chunk("hel", None));
        t.fold_chunk(text_chunk("lo", Some("stop")));
        assert_eq!(t.assistant_text, "hello");
        assert_eq!(t.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn fold_chunk_accumulates_tool_calls() {
        let mut t = Turn::new();
        t.fold_chunk(tool_chunk(
            0,
            OpenAiToolCallDelta {
                index: 0,
                id: Some("tu_1".into()),
                kind: Some("function".into()),
                function: Some(OpenAiToolCallFunctionDelta {
                    name: Some("Read".into()),
                    arguments: Some("{\"path\":\"".into()),
                }),
            },
            None,
        ));
        t.fold_chunk(tool_chunk(
            0,
            OpenAiToolCallDelta {
                index: 0,
                id: None,
                kind: None,
                function: Some(OpenAiToolCallFunctionDelta {
                    name: None,
                    arguments: Some("/tmp/x\"}".into()),
                }),
            },
            Some("tool_calls"),
        ));
        assert!(t.wants_tool_dispatch());
        let calls = t.drain_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "tu_1");
        assert_eq!(calls[0].function.name, "Read");
        assert_eq!(calls[0].function.arguments, "{\"path\":\"/tmp/x\"}");
    }

    #[derive(Default)]
    struct FakeDispatcher;
    impl ToolDispatcher for FakeDispatcher {
        fn dispatch(&self, name: &str, _args: &Value) -> Result<Value> {
            Ok(json!({"ok": name}))
        }
    }

    #[tokio::test]
    async fn agent_loop_dispatches_tool_then_terminates() {
        // Turn 1 → model asks for tool. Turn 2 → model replies plain text.
        let turn1: Vec<std::result::Result<OpenAiChunk, Error>> = vec![
            Ok(tool_chunk(
                0,
                OpenAiToolCallDelta {
                    index: 0,
                    id: Some("tu_1".into()),
                    kind: Some("function".into()),
                    function: Some(OpenAiToolCallFunctionDelta {
                        name: Some("Read".into()),
                        arguments: Some("{\"path\":\"/tmp/x\"}".into()),
                    }),
                },
                Some("tool_calls"),
            )),
        ];
        let turn2: Vec<std::result::Result<OpenAiChunk, Error>> = vec![
            Ok(text_chunk("final answer", Some("stop"))),
        ];
        let mut inbox = vec![turn1, turn2];

        let loop_ = AgentLoop {
            model: "m".into(),
            thinking: None,
            max_turns: 5,
            dispatcher: FakeDispatcher,
        };
        let initial = vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: "hi".into(),
            ..Default::default()
        }];
        let result = loop_
            .run(initial, |_req, _t| {
                let chunks = inbox.remove(0);
                async move {
                    let s: ChunkStream = Box::pin(stream::iter(chunks));
                    Ok(s)
                }
            })
            .await
            .unwrap();

        assert_eq!(result.turns, 2);
        assert!(!result.hit_turn_limit);
        // history = user + assistant(tool_calls) + tool_result + assistant(final)
        assert_eq!(result.history.len(), 4);
        assert_eq!(result.history[1].role, OpenAiChatRole::Assistant);
        assert_eq!(result.history[1].tool_calls.len(), 1);
        assert_eq!(result.history[2].role, OpenAiChatRole::Tool);
        assert_eq!(result.history[3].role, OpenAiChatRole::Assistant);
        assert_eq!(result.history[3].content, "final answer");
    }

    #[tokio::test]
    async fn agent_loop_respects_max_turns() {
        // Every turn asks for a tool → loop hits the cap.
        let loop_ = AgentLoop {
            model: "m".into(),
            thinking: None,
            max_turns: 3,
            dispatcher: FakeDispatcher,
        };
        let initial = vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: "hi".into(),
            ..Default::default()
        }];
        let result = loop_
            .run(initial, |_req, _t| async {
                let chunks: Vec<std::result::Result<OpenAiChunk, Error>> = vec![Ok(tool_chunk(
                    0,
                    OpenAiToolCallDelta {
                        index: 0,
                        id: Some("tu".into()),
                        kind: Some("function".into()),
                        function: Some(OpenAiToolCallFunctionDelta {
                            name: Some("Read".into()),
                            arguments: Some("{}".into()),
                        }),
                    },
                    Some("tool_calls"),
                ))];
                let s: ChunkStream = Box::pin(stream::iter(chunks));
                Ok(s)
            })
            .await
            .unwrap();
        assert_eq!(result.turns, 3);
        assert!(result.hit_turn_limit);
    }

    #[test]
    fn tool_result_message_shape() {
        let msg = tool_result_message("tu_1", &json!({"ok": true}));
        assert_eq!(msg.role, OpenAiChatRole::Tool);
        assert_eq!(msg.tool_call_id.as_deref(), Some("tu_1"));
        assert!(msg.content.contains("\"ok\":true"));
    }
}
