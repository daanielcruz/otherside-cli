

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

pub const MAX_AUTO_TURNS: u32 = 25;

#[derive(Debug, Clone, Default)]
pub struct Turn {

    pub assistant_text: String,

    pub tool_calls: HashMap<u32, PendingToolCall>,

    pub finish_reason: Option<String>,

    pub pending_usage: Option<crate::inference::OpenAiUsage>,
}

#[derive(Debug, Clone, Default)]
pub struct PendingToolCall {
    pub id: Option<String>,
    pub name: Option<String>,
    pub args_buffer: String,
}

impl PendingToolCall {

    pub fn merge(&mut self, delta: &OpenAiToolCallDelta) {
        if let Some(id) = &delta.id {
            self.id = Some(id.clone());
        }
        if let Some(f) = &delta.function {
            if let Some(name) = &f.name {

                self.name = Some(name.clone());
            }
            if let Some(args) = &f.arguments {
                self.args_buffer.push_str(args);
            }
        }
    }

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

    pub fn fold_chunk(&mut self, chunk: OpenAiChunk) -> Option<String> {
        if let Some(usage) = chunk.usage {
            let slot = self.pending_usage.get_or_insert_with(Default::default);
            if usage.input_tokens.is_some() {
                slot.input_tokens = usage.input_tokens;
            }
            if usage.output_tokens.is_some() {
                slot.output_tokens = usage.output_tokens;
            }
        }
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

    pub fn take_usage(&mut self) -> Option<crate::inference::OpenAiUsage> {
        self.pending_usage.take()
    }

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

pub trait ToolDispatcher {
    fn dispatch(&self, name: &str, args: &Value) -> Result<Value>;
}

#[derive(Debug, Default)]
pub struct DefaultToolDispatcher;

impl ToolDispatcher for DefaultToolDispatcher {
    fn dispatch(&self, name: &str, args: &Value) -> Result<Value> {
        tools::dispatch(name, args).map_err(|e| Error::Other(format!("tool `{name}`: {e}")))
    }
}

pub fn tool_result_message(call_id: &str, result: &Value) -> OpenAiChatMessage {
    let content = result
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            serde_json::to_string(result).unwrap_or_else(|_| result.to_string())
        });
    OpenAiChatMessage {
        role: OpenAiChatRole::Tool,
        content,
        name: None,
        tool_calls: Vec::new(),
        tool_call_id: Some(call_id.to_string()),
    }
}

pub struct AgentLoop<D: ToolDispatcher> {
    pub model: String,
    pub thinking: Option<ThinkingConfig>,
    pub max_turns: u32,
    pub dispatcher: D,
}

#[derive(Debug, Default)]
pub struct LoopResult {

    pub history: Vec<OpenAiChatMessage>,

    pub turns: u32,

    pub hit_turn_limit: bool,
}

impl<D: ToolDispatcher> AgentLoop<D> {

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
            usage: None,
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
            usage: None,
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

    #[test]
    fn fold_chunk_accumulates_usage_latest_wins_per_side() {

        use crate::inference::{OpenAiChoice, OpenAiDelta, OpenAiUsage};
        let mut t = Turn::new();
        t.fold_chunk(OpenAiChunk {
            id: "x".into(),
            object: OpenAiChunk::OBJECT.into(),
            created: 0,
            model: "m".into(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta::default(),
                finish_reason: None,
            }],
            usage: Some(OpenAiUsage {
                input_tokens: Some(1234),
                output_tokens: None,
            }),
        });
        t.fold_chunk(OpenAiChunk {
            id: "x".into(),
            object: OpenAiChunk::OBJECT.into(),
            created: 0,
            model: "m".into(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta::default(),
                finish_reason: None,
            }],
            usage: Some(OpenAiUsage {
                input_tokens: None,
                output_tokens: Some(56),
            }),
        });
        let drained = t.take_usage().expect("pending usage drained");
        assert_eq!(drained.input_tokens, Some(1234));
        assert_eq!(drained.output_tokens, Some(56));

        assert!(t.take_usage().is_none());
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

        assert_eq!(result.history.len(), 4);
        assert_eq!(result.history[1].role, OpenAiChatRole::Assistant);
        assert_eq!(result.history[1].tool_calls.len(), 1);
        assert_eq!(result.history[2].role, OpenAiChatRole::Tool);
        assert_eq!(result.history[3].role, OpenAiChatRole::Assistant);
        assert_eq!(result.history[3].content, "final answer");
    }

    #[tokio::test]
    async fn agent_loop_respects_max_turns() {

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

    #[test]
    fn tool_result_message_uses_content_field_when_present() {

        let msg = tool_result_message(
            "tu_bash",
            &json!({
                "status": "ok",
                "exit_code": 0,
                "content": "hello world\nwarn: stderr line",
                "stdout": "hello world\n",
                "stderr": "warn: stderr line\n",
            }),
        );
        assert_eq!(msg.content, "hello world\nwarn: stderr line");
    }

    #[test]
    fn tool_result_message_falls_back_to_json_when_no_content_field() {

        let msg = tool_result_message(
            "tu_read",
            &json!({"numLines": 3, "content_body": "line1\nline2\nline3"}),
        );

        assert!(msg.content.starts_with('{'));
        assert!(msg.content.contains("\"numLines\":3"));
    }
}
