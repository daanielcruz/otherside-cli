

use std::collections::HashMap;
use std::future::Future;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::inference::{
    OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole, OpenAiChunk, OpenAiToolCall,
    OpenAiToolCallDelta, OpenAiToolCallFunction, OpenAiToolDef,
};
use crate::provider::{ChunkStream, Provider};
use crate::thinking::ThinkingConfig;
use crate::tools;

pub mod compact;
pub mod subagents;

pub const MAX_AUTO_TURNS: u32 = 25;

#[derive(Debug, Clone, Default)]
pub struct Turn {

    pub assistant_text: String,

    pub tool_calls: HashMap<u32, PendingToolCall>,

    pub finish_reason: Option<String>,

    pub pending_usage: Option<crate::inference::OpenAiUsage>,

    // Accumulates thinking-block body text from `thinking_delta` SSE
    // events. Half of a round-trip pair; the other half is
    // `thinking_signature`. Both must be non-empty for the next request
    // to re-emit a Block::Thinking content block. Empty = drop the
    // thinking block entirely (kimi-cli pattern).
    pub reasoning_content: String,

    // Accumulates thinking-block signature from `signature_delta` SSE
    // events. Cryptographic integrity token over the thinking body;
    // kimi/anthropic validator rejects unsigned reused thinking.
    pub thinking_signature: String,
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
        if let Some(rc) = delta.reasoning_content {
            if !rc.is_empty() {
                self.reasoning_content.push_str(&rc);
            }
        }
        if let Some(sig) = delta.thinking_signature {
            if !sig.is_empty() {
                self.thinking_signature.push_str(&sig);
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlFlow {
    Continue,
    Abort,
}

pub trait ToolDispatcher: Send + Sync {
    fn dispatch<'a>(
        &'a self,
        tool_call_id: &'a str,
        name: &'a str,
        args: &'a Value,
    ) -> impl Future<Output = Result<Value>> + Send + 'a;
}

pub trait LoopObserver: Send + Sync {
    fn on_delta<'a>(&'a self, delta: &'a str) -> impl Future<Output = ControlFlow> + Send + 'a {
        let _ = delta;
        async { ControlFlow::Continue }
    }
    fn on_usage(
        &self,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> impl Future<Output = ControlFlow> + Send + '_ {
        let _ = (input_tokens, output_tokens);
        async { ControlFlow::Continue }
    }
    fn on_tool_start<'a>(
        &'a self,
        id: &'a str,
        name: &'a str,
        args: &'a Value,
    ) -> impl Future<Output = ControlFlow> + Send + 'a {
        let _ = (id, name, args);
        async { ControlFlow::Continue }
    }
    fn on_tool_finish<'a>(
        &'a self,
        id: &'a str,
        name: &'a str,
        result: std::result::Result<&'a Value, &'a str>,
        elapsed_ms: u64,
    ) -> impl Future<Output = ControlFlow> + Send + 'a {
        let _ = (id, name, result, elapsed_ms);
        async { ControlFlow::Continue }
    }
    fn on_turn_limit(&self, max_turns: u32) -> impl Future<Output = ()> + Send + '_ {
        let _ = max_turns;
        async {}
    }
    fn on_stream_error<'a>(&'a self, err: &'a Error) -> impl Future<Output = ()> + Send + 'a {
        let _ = err;
        async {}
    }
}

#[derive(Debug, Clone, Default)]
pub struct NoOpObserver;

impl LoopObserver for NoOpObserver {}

#[derive(Debug, Clone)]
enum Gate {
    Unrestricted,
    ToolsField(subagents::frontmatter::ToolsField),
}

#[derive(Debug, Clone)]
pub struct GatedDispatcher {
    gate: Gate,
    provider_id: crate::config::providers::ProviderId,
}

impl GatedDispatcher {
    pub fn unrestricted() -> Self {
        Self {
            gate: Gate::Unrestricted,
            provider_id: crate::config::providers::ProviderId::ClaudeCode,
        }
    }

    pub fn unrestricted_for(
        provider_id: crate::config::providers::ProviderId,
    ) -> Self {
        Self { gate: Gate::Unrestricted, provider_id }
    }

    pub fn from_tools_field(tools: subagents::frontmatter::ToolsField) -> Self {
        Self {
            gate: Gate::ToolsField(tools),
            provider_id: crate::config::providers::ProviderId::ClaudeCode,
        }
    }

    pub fn from_tools_field_with_provider(
        tools: subagents::frontmatter::ToolsField,
        provider_id: crate::config::providers::ProviderId,
    ) -> Self {
        Self { gate: Gate::ToolsField(tools), provider_id }
    }

    pub fn provider_id(&self) -> crate::config::providers::ProviderId {
        self.provider_id
    }

    fn allows(&self, name: &str) -> bool {
        match &self.gate {
            Gate::Unrestricted => true,
            Gate::ToolsField(subagents::frontmatter::ToolsField::Wildcard) => true,
            Gate::ToolsField(subagents::frontmatter::ToolsField::List(list)) => {
                list.iter().any(|t| t == name)
            }
        }
    }
}

impl Default for GatedDispatcher {
    fn default() -> Self {
        Self::unrestricted()
    }
}

impl ToolDispatcher for GatedDispatcher {
    fn dispatch<'a>(
        &'a self,
        _tool_call_id: &'a str,
        name: &'a str,
        args: &'a Value,
    ) -> impl Future<Output = Result<Value>> + Send + 'a {
        async move {
            if !self.allows(name) {
                return Err(Error::Other(format!(
                    "subagent cannot call tool `{name}` (not in allowlist)"
                )));
            }
            // Scope the provider thread-local across the SYNC tools::dispatch
            // call so per-provider tools (WebSearch) pick the right backend.
            // See src/tools/mod.rs::current_provider.
            crate::tools::with_current_provider(self.provider_id, || {
                tools::dispatch(name, args).map_err(|e| Error::Other(format!("tool `{name}`: {e}")))
            })
        }
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
        reasoning_content: None,
        thinking_signature: None,
    }
}

pub struct AgentLoop<D: ToolDispatcher, O: LoopObserver = NoOpObserver> {
    pub model: String,
    pub thinking: Option<ThinkingConfig>,
    pub max_turns: u32,
    pub tools: Vec<OpenAiToolDef>,
    pub tool_choice: Option<Value>,
    pub dispatcher: D,
    pub observer: O,
}

#[derive(Debug, Default)]
pub struct LoopResult {

    pub history: Vec<OpenAiChatMessage>,

    pub turns: u32,

    pub hit_turn_limit: bool,

    pub aborted: bool,

    pub total_input_tokens: u64,

    pub total_output_tokens: u64,
}

impl<D: ToolDispatcher, O: LoopObserver> AgentLoop<D, O> {

    pub async fn run<F, Fut>(
        &self,
        initial: Vec<OpenAiChatMessage>,
        mut stream_fn: F,
    ) -> Result<LoopResult>
    where
        F: FnMut(OpenAiChatRequest, Option<ThinkingConfig>) -> Fut + Send,
        Fut: std::future::Future<Output = Result<ChunkStream>> + Send,
    {
        use futures::StreamExt;

        let mut history = initial;
        let mut turns = 0u32;
        let mut total_input_tokens: u64 = 0;
        let mut total_output_tokens: u64 = 0;

        while turns < self.max_turns {
            turns += 1;
            let req = OpenAiChatRequest {
                model: self.model.clone(),
                messages: history.clone(),
                stream: Some(true),
                max_tokens: None,
                temperature: None,
                top_p: None,
                stop: None,
                tools: self.tools.clone(),
                tool_choice: self.tool_choice.clone(),
                extra: serde_json::Map::new(),
            };
            let mut stream = match stream_fn(req, self.thinking).await {
                Ok(s) => s,
                Err(e) => {
                    self.observer.on_stream_error(&e).await;
                    return Err(e);
                }
            };
            let mut turn = Turn::new();
            while let Some(item) = stream.next().await {
                match item {
                    Ok(chunk) => {
                        let emitted = turn.fold_chunk(chunk);
                        if let Some(usage) = turn.take_usage() {
                            total_input_tokens =
                                total_input_tokens.saturating_add(usage.input_tokens.unwrap_or(0));
                            total_output_tokens = total_output_tokens
                                .saturating_add(usage.output_tokens.unwrap_or(0));
                            if self
                                .observer
                                .on_usage(usage.input_tokens, usage.output_tokens)
                                .await
                                == ControlFlow::Abort
                            {
                                return Ok(LoopResult {
                                    history,
                                    turns,
                                    hit_turn_limit: false,
                                    aborted: true,
                                    total_input_tokens,
                                    total_output_tokens,
                                });
                            }
                        }
                        if let Some(text) = emitted {
                            if !text.is_empty()
                                && self.observer.on_delta(&text).await == ControlFlow::Abort
                            {
                                return Ok(LoopResult {
                                    history,
                                    turns,
                                    hit_turn_limit: false,
                                    aborted: true,
                                    total_input_tokens,
                                    total_output_tokens,
                                });
                            }
                        }
                    }
                    Err(e) => {
                        self.observer.on_stream_error(&e).await;
                        return Err(e);
                    }
                }
            }

            if turn.wants_tool_dispatch() && turn.has_pending_calls() {
                let tool_calls = turn.drain_calls();
                // Pair captured (reasoning_content, thinking_signature).
                // kimi-cli rule: signature-less thinking is STRIPPED, not
                // sent as empty. We mirror: both Some → thinking block
                // round-trips; either None → both become None.
                let (captured_reasoning, captured_signature) = if turn.reasoning_content.is_empty()
                    || turn.thinking_signature.is_empty()
                {
                    (None, None)
                } else {
                    (
                        Some(std::mem::take(&mut turn.reasoning_content)),
                        Some(std::mem::take(&mut turn.thinking_signature)),
                    )
                };
                let assistant_msg = OpenAiChatMessage {
                    role: OpenAiChatRole::Assistant,
                    content: turn.assistant_text.clone(),
                    name: None,
                    tool_calls: tool_calls.clone(),
                    tool_call_id: None,
                    reasoning_content: captured_reasoning,
                    thinking_signature: captured_signature,
                };
                history.push(assistant_msg);
                for call in &tool_calls {
                    let args_value: Value = serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| Value::String(call.function.arguments.clone()));
                    let started = std::time::Instant::now();
                    if self
                        .observer
                        .on_tool_start(&call.id, &call.function.name, &args_value)
                        .await
                        == ControlFlow::Abort
                    {
                        return Ok(LoopResult {
                            history,
                            turns,
                            hit_turn_limit: false,
                            aborted: true,
                            total_input_tokens,
                            total_output_tokens,
                        });
                    }
                    let dispatch_outcome = self
                        .dispatcher
                        .dispatch(&call.id, &call.function.name, &args_value)
                        .await;
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    let (history_value, observer_payload) = match &dispatch_outcome {
                        Ok(v) => (v.clone(), Ok(v)),
                        Err(e) => {
                            let s = format!("tool error: {e}");
                            (Value::String(s.clone()), Err(s))
                        }
                    };
                    let observer_result: std::result::Result<&Value, &str> =
                        match &observer_payload {
                            Ok(v) => Ok(*v),
                            Err(s) => Err(s.as_str()),
                        };
                    if self
                        .observer
                        .on_tool_finish(
                            &call.id,
                            &call.function.name,
                            observer_result,
                            elapsed_ms,
                        )
                        .await
                        == ControlFlow::Abort
                    {
                        return Ok(LoopResult {
                            history,
                            turns,
                            hit_turn_limit: false,
                            aborted: true,
                            total_input_tokens,
                            total_output_tokens,
                        });
                    }
                    history.push(tool_result_message(&call.id, &history_value));
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
                    reasoning_content: None,
                    thinking_signature: None,
                });
            }
            return Ok(LoopResult {
                history,
                turns,
                hit_turn_limit: false,
                aborted: false,
                total_input_tokens,
                total_output_tokens,
            });
        }

        self.observer.on_turn_limit(self.max_turns).await;
        Ok(LoopResult {
            history,
            turns,
            hit_turn_limit: true,
            aborted: false,
            total_input_tokens,
            total_output_tokens,
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
        tools: Vec::new(),
        tool_choice: None,
        dispatcher: GatedDispatcher::unrestricted(),
        observer: NoOpObserver,
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
                    ..Default::default()
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
                    ..Default::default()
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

    fn reasoning_chunk(text: &str) -> OpenAiChunk {
        OpenAiChunk {
            id: "chatcmpl-t".into(),
            object: OpenAiChunk::OBJECT.into(),
            created: 0,
            model: "m".into(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    reasoning_content: Some(text.to_string()),
                    ..Default::default()
                },
                finish_reason: None,
            }],
            usage: None,
        }
    }

    fn signature_chunk(text: &str) -> OpenAiChunk {
        OpenAiChunk {
            id: "chatcmpl-t".into(),
            object: OpenAiChunk::OBJECT.into(),
            created: 0,
            model: "m".into(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    thinking_signature: Some(text.to_string()),
                    ..Default::default()
                },
                finish_reason: None,
            }],
            usage: None,
        }
    }

    #[test]
    fn turn_fold_captures_reasoning_content_from_stream() {
        // Simulate the translator emitting `thinking_delta` / `reasoning_content_delta`
        // chunks (shape: `OpenAiDelta.reasoning_content = Some(...)`).
        // Turn::fold_chunk must accumulate into `turn.reasoning_content`
        // so the agent loop can attach it to the assistant tool-call
        // message and round-trip to kimi.
        let mut t = Turn::new();
        t.fold_chunk(reasoning_chunk("Let me think "));
        t.fold_chunk(reasoning_chunk("about this. "));
        t.fold_chunk(reasoning_chunk("I'll Glob first."));
        // Interleave with text + a tool call to prove the fold coexists.
        t.fold_chunk(text_chunk("Reading files now.", None));
        t.fold_chunk(tool_chunk(
            0,
            OpenAiToolCallDelta {
                index: 0,
                id: Some("tu_rc".into()),
                kind: Some("function".into()),
                function: Some(OpenAiToolCallFunctionDelta {
                    name: Some("Glob".into()),
                    arguments: Some("{}".into()),
                }),
            },
            Some("tool_calls"),
        ));

        assert_eq!(
            t.reasoning_content, "Let me think about this. I'll Glob first.",
            "Turn accumulator must concatenate reasoning_content deltas in order",
        );
        assert_eq!(t.assistant_text, "Reading files now.");
        assert!(t.wants_tool_dispatch());
    }

    #[tokio::test]
    async fn agent_loop_attaches_reasoning_content_to_tool_call_assistant_msg() {
        // End-to-end check: thinking_delta + signature_delta chunks flow
        // through the stream, Turn folds them as a pair, and the
        // assistant tool-call message pushed into history carries BOTH
        // the captured reasoning AND the signature. kimi-cli rule:
        // signature-less thinking is dropped; both must round-trip.
        let turn1: Vec<std::result::Result<OpenAiChunk, Error>> = vec![
            Ok(reasoning_chunk("kimi-think-step-1 ")),
            Ok(reasoning_chunk("kimi-think-step-2")),
            Ok(signature_chunk("sig-from-wire")),
            Ok(tool_chunk(
                0,
                OpenAiToolCallDelta {
                    index: 0,
                    id: Some("tu_rc1".into()),
                    kind: Some("function".into()),
                    function: Some(OpenAiToolCallFunctionDelta {
                        name: Some("Glob".into()),
                        arguments: Some("{}".into()),
                    }),
                },
                Some("tool_calls"),
            )),
        ];
        let turn2: Vec<std::result::Result<OpenAiChunk, Error>> =
            vec![Ok(text_chunk("done", Some("stop")))];
        let mut inbox = vec![turn1, turn2];

        let loop_ = AgentLoop {
            model: "kimi".into(),
            thinking: None,
            max_turns: 5,
            tools: Vec::new(),
            tool_choice: None,
            dispatcher: FakeDispatcher,
            observer: NoOpObserver,
        };
        let initial = vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: "list rs".into(),
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

        let assistant_tool_msg = result
            .history
            .iter()
            .find(|m| m.role == OpenAiChatRole::Assistant && !m.tool_calls.is_empty())
            .expect("assistant tool-call message landed in history");
        assert_eq!(
            assistant_tool_msg.reasoning_content.as_deref(),
            Some("kimi-think-step-1 kimi-think-step-2"),
            "captured reasoning must ride on the tool-call assistant message",
        );
        assert_eq!(
            assistant_tool_msg.thinking_signature.as_deref(),
            Some("sig-from-wire"),
            "captured signature must pair with reasoning for the round-trip",
        );
    }

    #[tokio::test]
    async fn agent_loop_drops_thinking_when_signature_missing() {
        // kimi-cli rule regression. Stream emits reasoning_content but
        // never a signature_delta (real-world case: malformed wire, or
        // a provider that doesn't emit signatures). Agent loop MUST
        // drop both halves — signature-less thinking would 400 on kimi
        // round-trip anyway.
        let turn1: Vec<std::result::Result<OpenAiChunk, Error>> = vec![
            Ok(reasoning_chunk("unsigned reasoning")),
            Ok(tool_chunk(
                0,
                OpenAiToolCallDelta {
                    index: 0,
                    id: Some("tu_unsig".into()),
                    kind: Some("function".into()),
                    function: Some(OpenAiToolCallFunctionDelta {
                        name: Some("Glob".into()),
                        arguments: Some("{}".into()),
                    }),
                },
                Some("tool_calls"),
            )),
        ];
        let turn2: Vec<std::result::Result<OpenAiChunk, Error>> =
            vec![Ok(text_chunk("done", Some("stop")))];
        let mut inbox = vec![turn1, turn2];

        let loop_ = AgentLoop {
            model: "kimi".into(),
            thinking: None,
            max_turns: 5,
            tools: Vec::new(),
            tool_choice: None,
            dispatcher: FakeDispatcher,
            observer: NoOpObserver,
        };
        let initial = vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: "list".into(),
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

        let assistant_tool_msg = result
            .history
            .iter()
            .find(|m| m.role == OpenAiChatRole::Assistant && !m.tool_calls.is_empty())
            .expect("assistant tool-call message landed in history");
        assert!(
            assistant_tool_msg.reasoning_content.is_none(),
            "reasoning dropped when signature missing (kimi-cli pattern)",
        );
        assert!(
            assistant_tool_msg.thinking_signature.is_none(),
            "signature stays None when pair broken",
        );
    }

    #[derive(Default)]
    struct FakeDispatcher;
    impl ToolDispatcher for FakeDispatcher {
        fn dispatch<'a>(
            &'a self,
            _tool_call_id: &'a str,
            name: &'a str,
            _args: &'a Value,
        ) -> impl Future<Output = Result<Value>> + Send + 'a {
            let name = name.to_string();
            async move { Ok(json!({"ok": name})) }
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
            tools: Vec::new(),
            tool_choice: None,
            dispatcher: FakeDispatcher,
            observer: NoOpObserver,
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
            tools: Vec::new(),
            tool_choice: None,
            dispatcher: FakeDispatcher,
            observer: NoOpObserver,
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
    fn gated_dispatcher_unrestricted_allows_any_tool() {
        let g = GatedDispatcher::unrestricted();
        for name in ["Read", "Bash", "Edit", "Agent"] {
            assert!(g.allows(name), "unrestricted must allow `{name}`");
        }
    }

    #[test]
    fn gated_dispatcher_wildcard_allows_any_tool() {
        use crate::agent::subagents::frontmatter::ToolsField;
        let g = GatedDispatcher::from_tools_field(ToolsField::Wildcard);
        for name in ["Read", "Bash", "Edit", "Agent"] {
            assert!(g.allows(name), "wildcard must allow `{name}`");
        }
    }

    #[test]
    fn gated_dispatcher_list_restricts() {
        use crate::agent::subagents::frontmatter::ToolsField;
        let g = GatedDispatcher::from_tools_field(ToolsField::List(vec![
            "Read".into(),
            "Glob".into(),
        ]));
        assert!(g.allows("Read"));
        assert!(g.allows("Glob"));
        assert!(!g.allows("Bash"));
        assert!(!g.allows("Edit"));
    }

    #[tokio::test]
    async fn gated_dispatcher_denies_out_of_allowlist_with_error() {
        use crate::agent::subagents::frontmatter::ToolsField;
        let g = GatedDispatcher::from_tools_field(ToolsField::List(vec!["Read".into()]));
        let err = g
            .dispatch("", "Bash", &json!({"command": "ls"}))
            .await
            .unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("Bash"));
        assert!(msg.contains("allowlist"));
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
