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

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::error::{Error, Result};
use crate::inference::{OpenAiChatRole, OpenAiChoice, OpenAiChunk, OpenAiDelta};

use super::sse::SseEvent;

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

        match event_name {
            "message_start" => self.handle_message_start(&value),
            "content_block_delta" => self.handle_content_block_delta(&value),
            "message_delta" => self.handle_message_delta(&value),
            "message_stop" => self.handle_message_stop(),
            // Everything else (ping, content_block_start, content_block_stop,
            // and any future event types) maps to no client chunk.
            _ => Ok(None),
        }
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

        // Emit the standard OpenAI "role announcement" chunk — empty
        // content, role=assistant. Many OpenAI clients rely on seeing
        // this before any content deltas.
        if self.role_emitted {
            return Ok(None);
        }
        self.role_emitted = true;
        Ok(Some(self.build_chunk(
            OpenAiDelta {
                role: Some(OpenAiChatRole::Assistant),
                content: None,
            },
            None,
        )))
    }

    fn handle_content_block_delta(&mut self, value: &Value) -> Result<Option<OpenAiChunk>> {
        // Only `text_delta` variants produce OpenAI content. Other
        // delta types (`thinking_delta`, `signature_delta`,
        // `input_json_delta` for tool calls) are not surfaced on the
        // OpenAI channel in MVP.
        let delta_obj = value
            .get("delta")
            .ok_or_else(|| Error::Sse("content_block_delta missing `delta`".into()))?;
        let delta_type = delta_obj.get("type").and_then(Value::as_str).unwrap_or("");
        if delta_type != "text_delta" {
            return Ok(None);
        }
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
            },
            None,
        )))
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
        // `message_delta` does not itself yield a client-visible chunk
        // — the finish_reason rides the final chunk emitted on
        // `message_stop`.
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
            },
            Some(finish_reason),
        )))
    }

    /// Assemble an [`OpenAiChunk`] from the translator's current id /
    /// model / created state plus a per-event delta.
    fn build_chunk(&self, delta: OpenAiDelta, finish_reason: Option<String>) -> OpenAiChunk {
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
        }
    }
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
        let wire = include_bytes!("../../fingerprint_corpus/hello/response.sse");
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
        // to a deterministic chunk sequence — role announcement, two
        // text deltas, terminator.
        let events = parse_corpus_events();
        let chunks = stream_events(&events).expect("translation must succeed");

        // Expected: 1 role chunk + 2 text deltas + 1 final = 4 chunks.
        assert_eq!(chunks.len(), 4, "chunk count diverged from corpus");

        // Chunk 0: role announcement.
        assert_eq!(chunks[0].choices[0].delta.role, Some(OpenAiChatRole::Assistant));
        assert_eq!(chunks[0].choices[0].delta.content, None);
        assert!(chunks[0].choices[0].finish_reason.is_none());
        // id + model come from message_start.
        assert_eq!(chunks[0].id, "XXX_MESSAGE_ID_XXX");
        assert_eq!(chunks[0].model, "claude-opus-4-7");
        assert_eq!(chunks[0].object, "chat.completion.chunk");

        // Chunk 1: first text delta.
        assert_eq!(chunks[1].choices[0].delta.role, None);
        assert_eq!(chunks[1].choices[0].delta.content.as_deref(), Some("Hi! How"));
        assert!(chunks[1].choices[0].finish_reason.is_none());

        // Chunk 2: second text delta.
        assert_eq!(chunks[2].choices[0].delta.content.as_deref(), Some(" can I help?"));

        // Chunk 3: terminator with finish_reason stop (end_turn → stop).
        assert_eq!(chunks[3].choices[0].delta.role, None);
        assert_eq!(chunks[3].choices[0].delta.content, None);
        assert_eq!(chunks[3].choices[0].finish_reason.as_deref(), Some("stop"));

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
}
