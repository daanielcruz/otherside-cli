//! `anthropic → openai` SSE event translator.
//!
//! Consumes Anthropic `/v1/messages` stream events (already parsed by
//! [`super::sse`] into [`SseEvent`]) and emits canonical
//! [`OpenAiChunk`]s.
//!
//! # Why stateful
//!
//! The Anthropic stream carries `id` and `model` only in `message_start`;
//! every subsequent chunk that OpenAI clients expect must repeat those
//! fields. Similarly, `message_delta` supplies `stop_reason` ahead of the
//! actual terminator (`message_stop`), so we remember it and stamp it on
//! the final chunk's `finish_reason`. A translator that is purely
//! per-event would lose that binding.
//!
//! # Event mapping
//!
//! | Anthropic event            | OpenAI chunk emission                           |
//! |----------------------------|-------------------------------------------------|
//! | `message_start`            | First chunk: `delta.role = assistant`, empty content |
//! | `content_block_start`      | Nothing (empty text block only for MVP)         |
//! | `ping`                     | Nothing (SSE keep-alive)                        |
//! | `content_block_delta` (`text_delta`) | Chunk with `delta.content` = the text delta |
//! | `content_block_delta` (`thinking_delta` / `signature_delta`) | Nothing in MVP (thinking surface not exposed yet) |
//! | `content_block_stop`       | Nothing                                         |
//! | `message_delta`            | Remember `stop_reason` for final chunk          |
//! | `message_stop`             | Final chunk: empty delta, `finish_reason` set   |
//!
//! # Stop reason mapping
//!
//! | Anthropic `stop_reason` | OpenAI `finish_reason` |
//! |-------------------------|-----------------------|
//! | `end_turn`              | `stop`                |
//! | `stop_sequence`         | `stop`                |
//! | `max_tokens`            | `length`              |
//! | `tool_use`              | `tool_calls`          |
//! | (other / missing)       | `stop`                |
//!
//! # Timestamps
//!
//! OpenAI chunks carry a `created` Unix epoch seconds field. We stamp it
//! from the first `message_start` using `SystemTime::now()` — this is
//! what OpenAI backends themselves do and matches what clients expect
//! (approximately "when the response started").

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::error::{Error, Result};
use crate::inference::{
    OpenAiChatRole, OpenAiChoice, OpenAiChunk, OpenAiDelta, OpenAiToolCallDelta,
    OpenAiToolCallFunctionDelta, OpenAiUsage,
};

use crate::translator::sse::SseEvent;

/// Per-block bookkeeping for tool_use content blocks. Anthropic's
/// stream delivers a `content_block_start` (which carries `id` and
/// `name` but NOT the input JSON), then one-or-more
/// `content_block_delta` with `input_json_delta.partial_json`
/// fragments, then `content_block_stop`. OpenAI's shape needs a
/// monotonically increasing call index per tool_use — we count up
/// from zero so the index is stable across the translated chunks.
#[derive(Debug, Clone)]
struct ToolBlock {
    /// OpenAI tool-call index. Not the same as Anthropic's content
    /// block index (which can skip past text blocks).
    call_index: u32,
    /// Retained for potential future use (e.g. matching tool_result
    /// blocks back to the original id on the next request).
    #[allow(dead_code)]
    id: String,
}

/// Translator state threaded across successive [`SseEvent`]s.
///
/// Holding state in a struct (not globals) keeps the translator
/// instance-per-stream so concurrent inference calls don't interfere.
#[derive(Debug)]
pub struct AnthropicStreamTranslator {
    /// OpenAI chunk `id` — derived from Anthropic `message.id`.
    id: Option<String>,
    /// OpenAI chunk `model` — derived from Anthropic `message.model`.
    model: Option<String>,
    /// `created` stamp set when we process `message_start`.
    created: u64,
    /// Anthropic's announced stop reason (from `message_delta`),
    /// preserved until `message_stop` emits the final chunk.
    stop_reason: Option<String>,
    /// Whether the first `role: assistant` chunk has been emitted.
    /// Prevents duplicate role chunks if the stream delivers extra
    /// `message_start` frames.
    role_emitted: bool,
    /// tool_use blocks live in here keyed by Anthropic's `index`.
    /// Drained on `content_block_stop`.
    tool_blocks: HashMap<u32, ToolBlock>,
    /// Running count used to assign OpenAI tool-call indexes in the
    /// order the blocks opened.
    next_tool_index: u32,
}

impl Default for AnthropicStreamTranslator {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicStreamTranslator {
    /// Create a fresh translator. Call once per inference stream.
    pub fn new() -> Self {
        Self {
            id: None,
            model: None,
            created: now_epoch_seconds(),
            stop_reason: None,
            role_emitted: false,
            tool_blocks: HashMap::new(),
            next_tool_index: 0,
        }
    }

    /// Consume one [`SseEvent`] and return any [`OpenAiChunk`] that
    /// should be emitted to the caller.
    ///
    /// - `Ok(Some(chunk))` — emit this chunk now.
    /// - `Ok(None)` — the event was processed but produces no client
    ///   chunk (e.g. ping, content_block_start).
    /// - `Err(Error::Sse(_))` — malformed event payload. Caller decides
    ///   whether to terminate the stream.
    pub fn on_event(&mut self, event: &SseEvent) -> Result<Option<OpenAiChunk>> {
        // Ignore framing-only events with empty data.
        if event.data.is_empty() {
            return Ok(None);
        }
        // Parse the JSON payload. Malformed JSON is surfaced as
        // `Error::Sse` — the caller may choose to drop this frame or
        // terminate the stream.
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|e| Error::Sse(format!("invalid JSON in event {:?}: {e}", event.event)))?;

        // Trust the SSE `event:` field, but fall back to the `type`
        // field inside the JSON payload in case the SSE layer dropped
        // the header (defensive — corpus always has both).
        let event_name = if !event.event.is_empty() {
            event.event.as_str()
        } else {
            value.get("type").and_then(Value::as_str).unwrap_or("")
        };

        let result = match event_name {
            "message_start" => self.handle_message_start(&value),
            "content_block_start" => self.handle_content_block_start(&value),
            "content_block_delta" => self.handle_content_block_delta(&value),
            "content_block_stop" => Ok(None),
            "message_delta" => self.handle_message_delta(&value),
            "message_stop" => self.handle_message_stop(),
            // `event: error` carries a server-side failure mid-stream
            // (invalid body shape, rate spike, internal error). The
            // server still returns 200 with an SSE `error` frame rather
            // than a 4xx HTTP status, so without surfacing here the
            // stream would drain cleanly with zero chunks and the CLI
            // would exit 0 with no output. Lift to Error::Sse so the
            // caller prints the server's message.
            "error" => {
                let msg = value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| event.data.as_str());
                Err(Error::Sse(format!("server: {msg}")))
            }
            // Everything else (ping, and any future event types) maps
            // to no client chunk.
            _ => Ok(None),
        };
        if let Ok(Some(_)) = &result {
            tracing::trace!(
                target: "otherside::stream",
                hop = "translator_chunk_emit",
                event = event_name,
                "AnthropicStreamTranslator yielding OpenAiChunk"
            );
        }
        result
    }

    fn handle_content_block_start(&mut self, value: &Value) -> Result<Option<OpenAiChunk>> {
        let block = value
            .get("content_block")
            .ok_or_else(|| Error::Sse("content_block_start missing `content_block`".into()))?;
        let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
        if block_type != "tool_use" {
            // text / thinking blocks produce no immediate chunk.
            return Ok(None);
        }
        let anthropic_index = value
            .get("index")
            .and_then(Value::as_u64)
            .map(|i| i as u32)
            .ok_or_else(|| Error::Sse("content_block_start missing `index`".into()))?;
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Sse("tool_use block missing `id`".into()))?
            .to_string();
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Sse("tool_use block missing `name`".into()))?
            .to_string();
        let call_index = self.next_tool_index;
        self.next_tool_index = self.next_tool_index.wrapping_add(1);
        self.tool_blocks.insert(
            anthropic_index,
            ToolBlock {
                call_index,
                id: id.clone(),
            },
        );
        // Emit the call-header chunk — OpenAI clients expect `id`,
        // `type:"function"`, and `function.name` on the first fragment.
        let delta = OpenAiDelta {
            role: None,
            content: None,
            tool_calls: vec![OpenAiToolCallDelta {
                index: call_index,
                id: Some(id),
                kind: Some("function".into()),
                function: Some(OpenAiToolCallFunctionDelta {
                    name: Some(name),
                    arguments: Some(String::new()),
                }),
            }],
        };
        Ok(Some(self.build_chunk(delta, None)))
    }

    fn handle_message_start(&mut self, value: &Value) -> Result<Option<OpenAiChunk>> {
        // `message_start.message.id` and `.model` are the canonical
        // anchors for every subsequent chunk in this response.
        let message = value
            .get("message")
            .ok_or_else(|| Error::Sse("message_start missing `message` field".into()))?;
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Sse("message_start missing `message.id`".into()))?
            .to_string();
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Sse("message_start missing `message.model`".into()))?
            .to_string();

        self.id = Some(id);
        self.model = Some(model);
        // Refresh created stamp — matches what OpenAI backends do: stamp
        // at the moment the first chunk is emitted.
        self.created = now_epoch_seconds();

        // `message.usage.input_tokens` is the canonical prompt-size
        // anchor. Anthropic also ships `cache_read_input_tokens` /
        // `cache_creation_input_tokens` as separate ledger buckets;
        // fold them into the same total so the progress line's `↑ N
        // tokens` reflects what actually counted against the context
        // window, not just the "uncached" slice.
        let usage = extract_input_usage(message.get("usage"));

        // Emit the standard OpenAI "role announcement" chunk — empty
        // content, role=assistant. Many OpenAI clients rely on seeing
        // this before any content deltas.
        if self.role_emitted {
            // Already emitted the role once — a later message_start
            // (rare; real streams send one) still needs to surface
            // usage, so emit a usage-only chunk with empty delta.
            if usage.is_some() {
                return Ok(Some(self.build_chunk_with_usage(
                    OpenAiDelta::default(),
                    None,
                    usage,
                )));
            }
            return Ok(None);
        }
        self.role_emitted = true;
        Ok(Some(self.build_chunk_with_usage(
            OpenAiDelta {
                role: Some(OpenAiChatRole::Assistant),
                content: None,
                tool_calls: Vec::new(),
            },
            None,
            usage,
        )))
    }

    fn handle_content_block_delta(&mut self, value: &Value) -> Result<Option<OpenAiChunk>> {
        let delta_obj = value
            .get("delta")
            .ok_or_else(|| Error::Sse("content_block_delta missing `delta`".into()))?;
        let delta_type = delta_obj.get("type").and_then(Value::as_str).unwrap_or("");
        match delta_type {
            "text_delta" => {
                let text = delta_obj
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if text.is_empty() {
                    return Ok(None);
                }
                Ok(Some(self.build_chunk(
                    OpenAiDelta {
                        role: None,
                        content: Some(text),
                        tool_calls: Vec::new(),
                    },
                    None,
                )))
            }
            "input_json_delta" => {
                let anthropic_index = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|i| i as u32)
                    .ok_or_else(|| Error::Sse("content_block_delta missing `index`".into()))?;
                let block = self.tool_blocks.get(&anthropic_index).ok_or_else(|| {
                    Error::Sse(format!(
                        "input_json_delta for unknown content block {anthropic_index}"
                    ))
                })?;
                let partial = delta_obj
                    .get("partial_json")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if partial.is_empty() {
                    return Ok(None);
                }
                Ok(Some(self.build_chunk(
                    OpenAiDelta {
                        role: None,
                        content: None,
                        tool_calls: vec![OpenAiToolCallDelta {
                            index: block.call_index,
                            id: None,
                            kind: None,
                            function: Some(OpenAiToolCallFunctionDelta {
                                name: None,
                                arguments: Some(partial),
                            }),
                        }],
                    },
                    None,
                )))
            }
            // thinking_delta / signature_delta are not surfaced on the
            // OpenAI channel in MVP.
            _ => Ok(None),
        }
    }

    fn handle_message_delta(&mut self, value: &Value) -> Result<Option<OpenAiChunk>> {
        // Anthropic announces the stop_reason in `message_delta` which
        // arrives BEFORE `message_stop`. We remember it and stamp it
        // onto the final chunk.
        if let Some(reason) = value
            .get("delta")
            .and_then(|d| d.get("stop_reason"))
            .and_then(Value::as_str)
        {
            self.stop_reason = Some(reason.to_string());
        }
        // `message_delta.usage.output_tokens` is a running counter —
        // every delta arrives with the cumulative total (not an
        // increment). Surface it as a usage-only chunk so the TUI's
        // progress line can paint `↑ Nk tokens` while the response
        // streams. Empty delta keeps the content channel untouched.
        let output_tokens = value
            .get("usage")
            .and_then(|u| u.get("output_tokens"))
            .and_then(Value::as_u64);
        if let Some(out) = output_tokens {
            let usage = OpenAiUsage {
                input_tokens: None,
                output_tokens: Some(out),
            };
            return Ok(Some(self.build_chunk_with_usage(
                OpenAiDelta::default(),
                None,
                Some(usage),
            )));
        }
        // No output_tokens surfaced yet — `message_delta` does not
        // itself yield a client-visible chunk. The finish_reason rides
        // the final chunk emitted on `message_stop`.
        Ok(None)
    }

    fn handle_message_stop(&self) -> Result<Option<OpenAiChunk>> {
        // Final chunk: empty delta, finish_reason mapped from Anthropic
        // stop_reason. If we never saw a stop_reason (e.g. an abrupt
        // end), default to `"stop"`.
        let finish_reason = self
            .stop_reason
            .as_deref()
            .map(map_stop_reason)
            .unwrap_or("stop")
            .to_string();
        Ok(Some(self.build_chunk(
            OpenAiDelta {
                role: None,
                content: None,
                tool_calls: Vec::new(),
            },
            Some(finish_reason),
        )))
    }

    /// Assemble an [`OpenAiChunk`] from the translator's current id /
    /// model / created state plus a per-event delta.
    fn build_chunk(&self, delta: OpenAiDelta, finish_reason: Option<String>) -> OpenAiChunk {
        self.build_chunk_with_usage(delta, finish_reason, None)
    }

    /// Variant of [`build_chunk`] that folds a usage envelope onto the
    /// emitted chunk. Only called from `handle_message_start` and
    /// `handle_message_delta` — every other emit path passes `None`
    /// through the bare `build_chunk` wrapper.
    fn build_chunk_with_usage(
        &self,
        delta: OpenAiDelta,
        finish_reason: Option<String>,
        usage: Option<OpenAiUsage>,
    ) -> OpenAiChunk {
        OpenAiChunk {
            id: self.id.clone().unwrap_or_default(),
            object: OpenAiChunk::OBJECT.to_string(),
            created: self.created,
            model: self.model.clone().unwrap_or_default(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta,
                finish_reason,
            }],
            usage,
        }
    }
}

/// Fold Anthropic's three input-token buckets
/// (`input_tokens` + `cache_read_input_tokens` +
/// `cache_creation_input_tokens`) into a single
/// [`OpenAiUsage`] carrying the sum as `input_tokens`. Returns `None`
/// when no bucket is present — callers skip emitting a usage chunk in
/// that case.
fn extract_input_usage(usage: Option<&Value>) -> Option<OpenAiUsage> {
    let usage = usage?;
    let base = usage.get("input_tokens").and_then(Value::as_u64);
    let cache_read = usage.get("cache_read_input_tokens").and_then(Value::as_u64);
    let cache_creation = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64);
    let total = base
        .or(cache_read)
        .or(cache_creation)
        .map(|_| base.unwrap_or(0) + cache_read.unwrap_or(0) + cache_creation.unwrap_or(0))?;
    Some(OpenAiUsage {
        input_tokens: Some(total),
        output_tokens: None,
    })
}

/// Map an Anthropic `stop_reason` string to OpenAI's `finish_reason`
/// vocabulary. Unknown reasons degrade to `"stop"`.
fn map_stop_reason(anthropic: &str) -> &'static str {
    match anthropic {
        "end_turn" | "stop_sequence" => "stop",
        "max_tokens" => "length",
        "tool_use" => "tool_calls",
        _ => "stop",
    }
}

/// Current time as Unix epoch seconds. Wrapped in a function so tests
/// (future) can shadow it with a fixed clock if needed.
fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Convenience: translate an entire sequence of [`SseEvent`]s in one
/// shot, collecting every emitted chunk. Used by tests — production
/// code drives [`AnthropicStreamTranslator::on_event`] incrementally as
/// bytes arrive.
pub fn stream_events(events: &[SseEvent]) -> Result<Vec<OpenAiChunk>> {
    let mut translator = AnthropicStreamTranslator::new();
    let mut out = Vec::with_capacity(events.len());
    for ev in events {
        if let Some(chunk) = translator.on_event(ev)? {
            out.push(chunk);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translator::sse::SseBuffer;

    fn parse_corpus_events() -> Vec<SseEvent> {
        // Corpus was scrubbed without the final blank line — model the
        // "connection closed" handoff with `flush_on_eof` so the trailing
        // message_stop event surfaces. The production driver (§11) does
        // the same when reqwest's stream ends.
        let wire = include_bytes!("../../../../fingerprint_corpus/hello/response.sse");
        let mut buf = SseBuffer::new();
        buf.push(wire);
        let mut events: Vec<_> = buf.drain().collect();
        if let Some(final_event) = buf.flush_on_eof() {
            events.push(final_event);
        }
        events
    }

    #[test]
    fn hello_corpus_produces_expected_chunk_sequence() {
        // Golden-file style test: the captured 8-event stream must map
        // to a deterministic chunk sequence — role announcement +
        // usage, two text deltas, usage-only chunk from
        // message_delta, terminator.
        let events = parse_corpus_events();
        let chunks = stream_events(&events).expect("translation must succeed");

        // Expected: 1 role chunk (with usage folded in) + 2 text
        // deltas + 1 usage-only chunk from message_delta + 1
        // terminator = 5 chunks.
        assert_eq!(chunks.len(), 5, "chunk count diverged from corpus");

        // Chunk 0: role announcement with input usage folded in.
        assert_eq!(chunks[0].choices[0].delta.role, Some(OpenAiChatRole::Assistant));
        assert_eq!(chunks[0].choices[0].delta.content, None);
        assert!(chunks[0].choices[0].finish_reason.is_none());
        // id + model come from message_start.
        assert_eq!(chunks[0].id, "XXX_MESSAGE_ID_XXX");
        assert_eq!(chunks[0].model, "claude-opus-4-7");
        assert_eq!(chunks[0].object, "chat.completion.chunk");
        // Usage folded from message_start.message.usage — sum of
        // input_tokens + cache_read + cache_creation buckets.
        let start_usage = chunks[0].usage.as_ref().expect("usage on role chunk");
        assert_eq!(start_usage.input_tokens, Some(6 + 14847 + 6732));

        // Chunk 1: first text delta.
        assert_eq!(chunks[1].choices[0].delta.role, None);
        assert_eq!(chunks[1].choices[0].delta.content.as_deref(), Some("Hi! How"));
        assert!(chunks[1].choices[0].finish_reason.is_none());

        // Chunk 2: second text delta.
        assert_eq!(chunks[2].choices[0].delta.content.as_deref(), Some(" can I help?"));

        // Chunk 3: usage-only from message_delta — no content, no
        // finish_reason, just the running output_tokens count.
        assert_eq!(chunks[3].choices[0].delta.content, None);
        assert!(chunks[3].choices[0].finish_reason.is_none());
        let delta_usage = chunks[3].usage.as_ref().expect("usage on delta chunk");
        assert_eq!(delta_usage.output_tokens, Some(13));

        // Chunk 4: terminator with finish_reason stop (end_turn → stop).
        assert_eq!(chunks[4].choices[0].delta.role, None);
        assert_eq!(chunks[4].choices[0].delta.content, None);
        assert_eq!(chunks[4].choices[0].finish_reason.as_deref(), Some("stop"));

        // All chunks share the same id and model.
        for c in &chunks {
            assert_eq!(c.id, "XXX_MESSAGE_ID_XXX");
            assert_eq!(c.model, "claude-opus-4-7");
        }
    }

    #[test]
    fn message_start_missing_id_errors() {
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "message_start".into(),
            data: r#"{"type":"message_start","message":{"model":"x"}}"#.into(),
            ..Default::default()
        };
        let err = t.on_event(&ev).unwrap_err();
        assert!(matches!(err, Error::Sse(_)));
    }

    #[test]
    fn unknown_event_type_ignored() {
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "future_event_type".into(),
            data: "{}".into(),
            ..Default::default()
        };
        assert!(t.on_event(&ev).unwrap().is_none());
    }

    #[test]
    fn ping_produces_no_chunk() {
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "ping".into(),
            data: r#"{"type":"ping"}"#.into(),
            ..Default::default()
        };
        assert!(t.on_event(&ev).unwrap().is_none());
    }

    #[test]
    fn content_block_start_text_produces_no_chunk() {
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "content_block_start".into(),
            data: r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#.into(),
            ..Default::default()
        };
        assert!(t.on_event(&ev).unwrap().is_none());
    }

    #[test]
    fn thinking_delta_ignored_in_mvp() {
        // `thinking_delta` events will surface once we expose a
        // thinking channel — for MVP they're silently dropped.
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "content_block_delta".into(),
            data: r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning..."}}"#.into(),
            ..Default::default()
        };
        assert!(t.on_event(&ev).unwrap().is_none());
    }

    #[test]
    fn max_tokens_stop_maps_to_length() {
        // Ensure the stop_reason → finish_reason mapping table is wired.
        let mut t = AnthropicStreamTranslator::new();
        t.on_event(&SseEvent {
            event: "message_start".into(),
            data: r#"{"type":"message_start","message":{"id":"m","model":"claude"}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        t.on_event(&SseEvent {
            event: "message_delta".into(),
            data: r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        let final_chunk = t
            .on_event(&SseEvent {
                event: "message_stop".into(),
                data: r#"{"type":"message_stop"}"#.into(),
                ..Default::default()
            })
            .unwrap()
            .unwrap();
        assert_eq!(final_chunk.choices[0].finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn empty_data_frame_ignored() {
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "ping".into(),
            data: "".into(),
            ..Default::default()
        };
        assert!(t.on_event(&ev).unwrap().is_none());
    }

    #[test]
    fn malformed_json_surfaces_sse_error() {
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "message_start".into(),
            data: "{not json".into(),
            ..Default::default()
        };
        let err = t.on_event(&ev).unwrap_err();
        assert!(matches!(err, Error::Sse(_)));
    }

    #[test]
    fn role_chunk_emitted_only_once() {
        // Two message_start events (hypothetical) should still produce
        // only one role announcement.
        let mut t = AnthropicStreamTranslator::new();
        let start = SseEvent {
            event: "message_start".into(),
            data: r#"{"type":"message_start","message":{"id":"m","model":"x"}}"#.into(),
            ..Default::default()
        };
        assert!(t.on_event(&start).unwrap().is_some());
        assert!(t.on_event(&start).unwrap().is_none());
    }

    #[test]
    fn missing_stop_reason_defaults_to_stop() {
        // If the server never sends `message_delta` with stop_reason,
        // we still close the stream gracefully with finish_reason=stop.
        let mut t = AnthropicStreamTranslator::new();
        t.on_event(&SseEvent {
            event: "message_start".into(),
            data: r#"{"type":"message_start","message":{"id":"m","model":"x"}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        let final_chunk = t
            .on_event(&SseEvent {
                event: "message_stop".into(),
                data: r#"{"type":"message_stop"}"#.into(),
                ..Default::default()
            })
            .unwrap()
            .unwrap();
        assert_eq!(final_chunk.choices[0].finish_reason.as_deref(), Some("stop"));
    }

    fn boot_translator() -> AnthropicStreamTranslator {
        let mut t = AnthropicStreamTranslator::new();
        t.on_event(&SseEvent {
            event: "message_start".into(),
            data: r#"{"type":"message_start","message":{"id":"m","model":"claude"}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        t
    }

    #[test]
    fn tool_use_block_emits_header_chunk() {
        let mut t = boot_translator();
        let ev = SseEvent {
            event: "content_block_start".into(),
            data: r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"Read","input":{}}}"#.into(),
            ..Default::default()
        };
        let chunk = t.on_event(&ev).unwrap().expect("header chunk emitted");
        let tc = &chunk.choices[0].delta.tool_calls[0];
        assert_eq!(tc.index, 0);
        assert_eq!(tc.id.as_deref(), Some("tu_1"));
        assert_eq!(tc.kind.as_deref(), Some("function"));
        let f = tc.function.as_ref().unwrap();
        assert_eq!(f.name.as_deref(), Some("Read"));
        assert_eq!(f.arguments.as_deref(), Some(""));
    }

    #[test]
    fn input_json_delta_accumulates_per_call_index() {
        let mut t = boot_translator();
        // Open two tool_use blocks back-to-back.
        t.on_event(&SseEvent {
            event: "content_block_start".into(),
            data: r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_a","name":"Read","input":{}}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        t.on_event(&SseEvent {
            event: "content_block_start".into(),
            data: r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_b","name":"Glob","input":{}}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        let c1 = t
            .on_event(&SseEvent {
                event: "content_block_delta".into(),
                data: r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\""}}"#.into(),
                ..Default::default()
            })
            .unwrap()
            .unwrap();
        let c2 = t
            .on_event(&SseEvent {
                event: "content_block_delta".into(),
                data: r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"pat"}}"#.into(),
                ..Default::default()
            })
            .unwrap()
            .unwrap();
        let tc1 = &c1.choices[0].delta.tool_calls[0];
        let tc2 = &c2.choices[0].delta.tool_calls[0];
        assert_eq!(tc1.index, 0);
        assert_eq!(tc2.index, 1);
        assert!(tc1
            .function
            .as_ref()
            .unwrap()
            .arguments
            .as_deref()
            .unwrap()
            .starts_with('{'));
    }

    #[test]
    fn input_json_delta_for_unknown_block_errors() {
        // If a partial arrives for a content block we never saw open,
        // surface it as an Sse error rather than silently ignore.
        let mut t = boot_translator();
        let err = t
            .on_event(&SseEvent {
                event: "content_block_delta".into(),
                data: r#"{"type":"content_block_delta","index":9,"delta":{"type":"input_json_delta","partial_json":"{}"}}"#.into(),
                ..Default::default()
            })
            .unwrap_err();
        assert!(matches!(err, Error::Sse(_)));
    }

    #[test]
    fn tool_use_stop_reason_maps_to_tool_calls() {
        let mut t = boot_translator();
        t.on_event(&SseEvent {
            event: "message_delta".into(),
            data: r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        let fin = t
            .on_event(&SseEvent {
                event: "message_stop".into(),
                data: r#"{"type":"message_stop"}"#.into(),
                ..Default::default()
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            fin.choices[0].finish_reason.as_deref(),
            Some("tool_calls")
        );
    }

    #[test]
    fn message_start_with_usage_rides_role_chunk() {
        // Regression anchor for the token-counter plumbing: the
        // first emitted chunk must carry the usage envelope
        // extracted from `message.usage` so the TUI progress line
        // paints `↑ N tokens` on the first frame after submit.
        let mut t = AnthropicStreamTranslator::new();
        let chunk = t
            .on_event(&SseEvent {
                event: "message_start".into(),
                data: r#"{"type":"message_start","message":{"id":"m","model":"x","usage":{"input_tokens":1234}}}"#.into(),
                ..Default::default()
            })
            .unwrap()
            .expect("role chunk emitted");
        let usage = chunk.usage.expect("usage rides role chunk");
        assert_eq!(usage.input_tokens, Some(1234));
        assert_eq!(usage.output_tokens, None);
    }

    #[test]
    fn message_start_usage_sums_cache_buckets() {
        // Cache-read + cache-creation tokens are part of the
        // effective prompt size. Roll them into `input_tokens`
        // so the context-window arithmetic doesn't underreport.
        let mut t = AnthropicStreamTranslator::new();
        let chunk = t
            .on_event(&SseEvent {
                event: "message_start".into(),
                data: r#"{"type":"message_start","message":{"id":"m","model":"x","usage":{"input_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":50}}}"#.into(),
                ..Default::default()
            })
            .unwrap()
            .expect("role chunk emitted");
        let usage = chunk.usage.expect("usage rides role chunk");
        assert_eq!(usage.input_tokens, Some(1050));
    }

    #[test]
    fn message_delta_emits_output_tokens_usage() {
        // `message_delta.usage.output_tokens` is a running cumulative
        // counter — every event MUST surface it to the TUI so the
        // progress line's output count grows as the stream drains.
        let mut t = boot_translator();
        let chunk = t
            .on_event(&SseEvent {
                event: "message_delta".into(),
                data: r#"{"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":56}}"#.into(),
                ..Default::default()
            })
            .unwrap()
            .expect("usage-bearing message_delta emits a chunk");
        let usage = chunk.usage.expect("usage present");
        assert_eq!(usage.output_tokens, Some(56));
        assert_eq!(usage.input_tokens, None);
    }

    #[test]
    fn message_delta_without_usage_remains_silent() {
        // Defensive: without a usage envelope the message_delta
        // path stays chunk-less so we don't spam the TUI with
        // empty frames every 50ms.
        let mut t = boot_translator();
        let out = t
            .on_event(&SseEvent {
                event: "message_delta".into(),
                data: r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#.into(),
                ..Default::default()
            })
            .unwrap();
        assert!(out.is_none());
    }
}
