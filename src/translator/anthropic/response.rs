
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::error::{Error, Result};
use crate::inference::{
    OpenAiChatRole, OpenAiChoice, OpenAiChunk, OpenAiDelta, OpenAiToolCallDelta,
    OpenAiToolCallFunctionDelta, OpenAiUsage,
};

use crate::translator::sse::SseEvent;

fn truncate_for_log(s: &str, cap: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= cap {
        return s.to_string();
    }
    let head: String = chars.into_iter().take(cap - 1).collect();
    format!("{head}…")
}

#[derive(Debug, Clone)]
struct ToolBlock {

    call_index: u32,

    #[allow(dead_code)]
    id: String,
}

#[derive(Debug)]
pub struct AnthropicStreamTranslator {

    id: Option<String>,

    model: Option<String>,

    created: u64,

    stop_reason: Option<String>,

    role_emitted: bool,

    tool_blocks: HashMap<u32, ToolBlock>,

    next_tool_index: u32,

    reasoning_content_buf: String,
    thinking_signature_buf: String,
}

impl Default for AnthropicStreamTranslator {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicStreamTranslator {

    pub fn new() -> Self {
        Self {
            id: None,
            model: None,
            created: now_epoch_seconds(),
            stop_reason: None,
            role_emitted: false,
            tool_blocks: HashMap::new(),
            next_tool_index: 0,
            reasoning_content_buf: String::new(),
            thinking_signature_buf: String::new(),
        }
    }

    pub fn take_reasoning_content(&mut self) -> Option<String> {
        if self.reasoning_content_buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.reasoning_content_buf))
        }
    }

    pub fn take_thinking_signature(&mut self) -> Option<String> {
        if self.thinking_signature_buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.thinking_signature_buf))
        }
    }

    pub fn on_event(&mut self, event: &SseEvent) -> Result<Option<OpenAiChunk>> {

        if event.data.is_empty() {
            return Ok(None);
        }

        let value: Value = serde_json::from_str(&event.data)
            .map_err(|e| Error::Sse(format!("invalid JSON in event {:?}: {e}", event.event)))?;

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

            "error" => {
                let msg = value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| event.data.as_str());
                Err(Error::Sse(format!("server: {msg}")))
            }

            other => {
                
                tracing::debug!(
                    target: "otherside::stream",
                    hop = "translator_unknown_event",
                    event = other,
                    data_preview = %truncate_for_log(&event.data, 120),
                    "AnthropicStreamTranslator dropping unrecognized SSE event"
                );
                Ok(None)
            }
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
            ..Default::default()
        };
        Ok(Some(self.build_chunk(delta, None)))
    }

    fn handle_message_start(&mut self, value: &Value) -> Result<Option<OpenAiChunk>> {

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

        self.created = now_epoch_seconds();

        let usage = extract_input_usage(message.get("usage"));

        if self.role_emitted {

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
                ..Default::default()
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
                        ..Default::default()
                    },
                    None,
                )))
            }
            
            "thinking_delta" => {
                let chunk = delta_obj
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if chunk.is_empty() {
                    return Ok(None);
                }
                self.reasoning_content_buf.push_str(&chunk);
                Ok(Some(self.build_chunk(
                    OpenAiDelta {
                        reasoning_content: Some(chunk),
                        ..Default::default()
                    },
                    None,
                )))
            }
            "signature_delta" => {
                
                let chunk = delta_obj
                    .get("signature")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if chunk.is_empty() {
                    return Ok(None);
                }
                self.thinking_signature_buf.push_str(&chunk);
                Ok(Some(self.build_chunk(
                    OpenAiDelta {
                        thinking_signature: Some(chunk),
                        ..Default::default()
                    },
                    None,
                )))
            }
            "reasoning_content_delta" => {
                let chunk = delta_obj
                    .get("reasoning_content")
                    .and_then(Value::as_str)
                    .or_else(|| delta_obj.get("text").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                if chunk.is_empty() {
                    return Ok(None);
                }
                self.reasoning_content_buf.push_str(&chunk);
                Ok(Some(self.build_chunk(
                    OpenAiDelta {
                        reasoning_content: Some(chunk),
                        ..Default::default()
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
                        ..Default::default()
                    },
                    None,
                )))
            }

            _ => Ok(None),
        }
    }

    fn handle_message_delta(&mut self, value: &Value) -> Result<Option<OpenAiChunk>> {

        if let Some(reason) = value
            .get("delta")
            .and_then(|d| d.get("stop_reason"))
            .and_then(Value::as_str)
        {
            self.stop_reason = Some(reason.to_string());
        }

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

        Ok(None)
    }

    fn handle_message_stop(&self) -> Result<Option<OpenAiChunk>> {

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
                ..Default::default()
            },
            Some(finish_reason),
        )))
    }

    fn build_chunk(&self, delta: OpenAiDelta, finish_reason: Option<String>) -> OpenAiChunk {
        self.build_chunk_with_usage(delta, finish_reason, None)
    }

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

fn map_stop_reason(anthropic: &str) -> &'static str {
    match anthropic {
        "end_turn" | "stop_sequence" => "stop",
        "max_tokens" => "length",
        "tool_use" => "tool_calls",
        _ => "stop",
    }
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

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

        let events = parse_corpus_events();
        let chunks = stream_events(&events).expect("translation must succeed");

        assert_eq!(chunks.len(), 5, "chunk count diverged from corpus");

        assert_eq!(chunks[0].choices[0].delta.role, Some(OpenAiChatRole::Assistant));
        assert_eq!(chunks[0].choices[0].delta.content, None);
        assert!(chunks[0].choices[0].finish_reason.is_none());

        assert_eq!(chunks[0].id, "XXX_MESSAGE_ID_XXX");
        assert_eq!(chunks[0].model, "claude-opus-4-7");
        assert_eq!(chunks[0].object, "chat.completion.chunk");

        let start_usage = chunks[0].usage.as_ref().expect("usage on role chunk");
        assert_eq!(start_usage.input_tokens, Some(6 + 14847 + 6732));

        assert_eq!(chunks[1].choices[0].delta.role, None);
        assert_eq!(chunks[1].choices[0].delta.content.as_deref(), Some("Hi! How"));
        assert!(chunks[1].choices[0].finish_reason.is_none());

        assert_eq!(chunks[2].choices[0].delta.content.as_deref(), Some(" can I help?"));

        assert_eq!(chunks[3].choices[0].delta.content, None);
        assert!(chunks[3].choices[0].finish_reason.is_none());
        let delta_usage = chunks[3].usage.as_ref().expect("usage on delta chunk");
        assert_eq!(delta_usage.output_tokens, Some(13));

        assert_eq!(chunks[4].choices[0].delta.role, None);
        assert_eq!(chunks[4].choices[0].delta.content, None);
        assert_eq!(chunks[4].choices[0].finish_reason.as_deref(), Some("stop"));

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
    fn signature_delta_accumulates_into_thinking_signature_buffer() {
        
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "content_block_delta".into(),
            data: r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc-123"}}"#.into(),
            ..Default::default()
        };
        let chunk = t
            .on_event(&ev)
            .unwrap()
            .expect("signature_delta emits a chunk carrying thinking_signature");
        assert_eq!(
            chunk.choices[0].delta.thinking_signature.as_deref(),
            Some("sig-abc-123"),
            "streamed chunk must carry the signature for fold_chunk",
        );
        assert!(chunk.choices[0].delta.content.is_none());
        assert!(chunk.choices[0].delta.reasoning_content.is_none());
        assert!(chunk.choices[0].delta.tool_calls.is_empty());
        assert_eq!(t.take_thinking_signature().as_deref(), Some("sig-abc-123"));
    }

    #[test]
    fn thinking_delta_accumulates_into_reasoning_content_buffer() {
        
        let mut t = AnthropicStreamTranslator::new();
        let ev = SseEvent {
            event: "content_block_delta".into(),
            data: r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning..."}}"#.into(),
            ..Default::default()
        };
        let chunk = t
            .on_event(&ev)
            .unwrap()
            .expect("thinking_delta emits a chunk carrying reasoning_content");
        assert_eq!(
            chunk.choices[0].delta.reasoning_content.as_deref(),
            Some("reasoning..."),
            "streamed chunk must carry the delta content for fold_chunk",
        );
        assert!(chunk.choices[0].delta.content.is_none());
        assert!(chunk.choices[0].delta.tool_calls.is_empty());
        
        assert_eq!(t.take_reasoning_content().as_deref(), Some("reasoning..."));
    }

    #[test]
    fn translator_accumulates_reasoning_content_internally() {
        
        let mut t = AnthropicStreamTranslator::new();
        t.on_event(&SseEvent {
            event: "content_block_delta".into(),
            data: r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step one "}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        t.on_event(&SseEvent {
            event: "content_block_delta".into(),
            data: r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step two"}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            t.take_reasoning_content().as_deref(),
            Some("step one step two")
        );
        
        assert!(t.take_reasoning_content().is_none());
    }

    #[test]
    fn reasoning_content_delta_variant_also_accumulates() {
        
        let mut t = AnthropicStreamTranslator::new();
        t.on_event(&SseEvent {
            event: "content_block_delta".into(),
            data: r#"{"type":"content_block_delta","index":0,"delta":{"type":"reasoning_content_delta","reasoning_content":"kimi-rc"}}"#.into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(t.take_reasoning_content().as_deref(), Some("kimi-rc"));
    }

    #[test]
    fn max_tokens_stop_maps_to_length() {

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
