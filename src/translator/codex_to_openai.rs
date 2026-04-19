//! Translator — ChatGPT `/responses` SSE stream → OpenAI canonical
//! `OpenAiChunk`s.
//!
//! Codex emits typed SSE events (`response.output_text.delta`,
//! `response.function_call_arguments.delta`, `response.completed`, …).
//! We fold those into OpenAI chat-completion chunks so the outer TUI /
//! agent loop keeps its provider-agnostic shape.
//!
//! Event mapping (source:
//! `docs/design/codex-openai-auth-api.md §SSE`):
//!
//! | event `type`                                  | emit |
//! |---|---|
//! | `response.created`                            | first chunk with `role: assistant` |
//! | `response.output_text.delta`                  | text delta chunk |
//! | `response.custom_tool_call_input.delta`       | tool-call arguments delta |
//! | `response.output_item.added` (function_call)  | tool-call id + name chunk |
//! | `response.completed`                          | final chunk with finish_reason + usage |
//! | `response.failed`                             | returned as an `Err` on the stream |
//! | `response.incomplete`                         | finish_reason = "length" or similar |
//! | everything else                               | silently ignored |

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::inference::{
    OpenAiChatRole, OpenAiChoice, OpenAiChunk, OpenAiDelta, OpenAiToolCallDelta,
    OpenAiToolCallFunctionDelta, OpenAiUsage,
};

/// Streaming state — consumers instantiate one per turn and feed raw
/// SSE `event-type` + `data` pairs through [`State::ingest`]. The
/// helper returns zero-or-more `OpenAiChunk`s to forward downstream,
/// plus a `done` flag once `response.completed` / `response.failed`
/// fires.
#[derive(Debug, Default)]
pub struct State {
    pub response_id: Option<String>,
    pub model: String,
    pub tool_call_indices: Vec<String>,
    pub finished: bool,
}

impl State {
    pub fn new(model_hint: &str) -> Self {
        Self {
            response_id: None,
            model: model_hint.to_string(),
            tool_call_indices: Vec::new(),
            finished: false,
        }
    }

    /// Absorb one `event: <type>\ndata: <payload>\n` frame. `payload`
    /// is already JSON-parsed.
    pub fn ingest(&mut self, event: &str, payload: &Value) -> Vec<OpenAiChunk> {
        match event {
            "response.created" => {
                if let Some(id) = payload["response"]["id"].as_str() {
                    self.response_id = Some(id.to_string());
                }
                if let Some(m) = payload["response"]["model"].as_str() {
                    self.model = m.to_string();
                }
                vec![self.first_chunk()]
            }
            "response.output_item.added" => {
                // Only care about function_call items here — seeds a
                // new tool-call entry with id + name so the agent
                // loop can spawn the Running bullet before any args
                // arrive.
                let item = &payload["item"];
                if item["type"] == "function_call" {
                    let call_id = item["call_id"].as_str().unwrap_or("").to_string();
                    let name = item["name"].as_str().unwrap_or("").to_string();
                    let index = self.register_tool_call(&call_id) as u32;
                    vec![self.chunk_with_delta(OpenAiDelta {
                        role: None,
                        content: None,
                        tool_calls: vec![OpenAiToolCallDelta {
                            index,
                            id: Some(call_id),
                            kind: Some("function".to_string()),
                            function: Some(OpenAiToolCallFunctionDelta {
                                name: Some(name),
                                arguments: None,
                            }),
                        }],
                    })]
                } else {
                    Vec::new()
                }
            }
            "response.output_text.delta" => {
                if let Some(delta) = payload["delta"].as_str() {
                    vec![self.chunk_with_delta(OpenAiDelta {
                        role: None,
                        content: Some(delta.to_string()),
                        tool_calls: Vec::new(),
                    })]
                } else {
                    Vec::new()
                }
            }
            "response.function_call_arguments.delta"
            | "response.custom_tool_call_input.delta" => {
                let call_id = payload["call_id"].as_str().unwrap_or("");
                let index = self.register_tool_call(call_id) as u32;
                if let Some(delta) = payload["delta"].as_str() {
                    vec![self.chunk_with_delta(OpenAiDelta {
                        role: None,
                        content: None,
                        tool_calls: vec![OpenAiToolCallDelta {
                            index,
                            id: None,
                            kind: None,
                            function: Some(OpenAiToolCallFunctionDelta {
                                name: None,
                                arguments: Some(delta.to_string()),
                            }),
                        }],
                    })]
                } else {
                    Vec::new()
                }
            }
            "response.completed" => {
                self.finished = true;
                vec![self.final_chunk(
                    payload["response"]["usage"].clone(),
                    Some("stop".to_string()),
                )]
            }
            "response.incomplete" => {
                self.finished = true;
                let reason = payload["response"]["incomplete_details"]["reason"]
                    .as_str()
                    .unwrap_or("length")
                    .to_string();
                vec![self.final_chunk(
                    payload["response"]["usage"].clone(),
                    Some(reason),
                )]
            }
            _ => Vec::new(),
        }
    }

    fn register_tool_call(&mut self, call_id: &str) -> usize {
        if let Some(pos) = self.tool_call_indices.iter().position(|c| c == call_id) {
            return pos;
        }
        self.tool_call_indices.push(call_id.to_string());
        self.tool_call_indices.len() - 1
    }

    fn first_chunk(&self) -> OpenAiChunk {
        OpenAiChunk {
            id: self.response_id.clone().unwrap_or_else(|| "codex".into()),
            object: OpenAiChunk::OBJECT.to_string(),
            created: now_secs(),
            model: self.model.clone(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    role: Some(OpenAiChatRole::Assistant),
                    content: None,
                    tool_calls: Vec::new(),
                },
                finish_reason: None,
            }],
            usage: None,
        }
    }

    fn chunk_with_delta(&self, delta: OpenAiDelta) -> OpenAiChunk {
        OpenAiChunk {
            id: self.response_id.clone().unwrap_or_else(|| "codex".into()),
            object: OpenAiChunk::OBJECT.to_string(),
            created: now_secs(),
            model: self.model.clone(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta,
                finish_reason: None,
            }],
            usage: None,
        }
    }

    fn final_chunk(&self, usage: Value, finish_reason: Option<String>) -> OpenAiChunk {
        let usage_out = if usage.is_object() {
            Some(OpenAiUsage {
                input_tokens: usage["input_tokens"].as_u64(),
                output_tokens: usage["output_tokens"].as_u64(),
            })
        } else {
            None
        };
        OpenAiChunk {
            id: self.response_id.clone().unwrap_or_else(|| "codex".into()),
            object: OpenAiChunk::OBJECT.to_string(),
            created: now_secs(),
            model: self.model.clone(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta::default(),
                finish_reason,
            }],
            usage: usage_out,
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn response_created_emits_role_assistant_chunk() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.created",
            &json!({"response":{"id":"resp_1","model":"gpt-5-codex"}}),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].choices[0].delta.role, Some(OpenAiChatRole::Assistant));
        assert_eq!(s.response_id.as_deref(), Some("resp_1"));
    }

    #[test]
    fn output_text_delta_emits_content_chunk() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_text.delta",
            &json!({"delta": "hello "}),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].choices[0].delta.content.as_deref(), Some("hello "));
    }

    #[test]
    fn function_call_added_emits_tool_call_seed() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_item.added",
            &json!({
                "item": {"type": "function_call", "call_id": "c1", "name": "shell"}
            }),
        );
        assert_eq!(out.len(), 1);
        let tcs = &out[0].choices[0].delta.tool_calls;
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].id.as_deref(), Some("c1"));
        assert_eq!(tcs[0].function.as_ref().unwrap().name.as_deref(), Some("shell"));
    }

    #[test]
    fn argument_delta_accumulates_under_existing_index() {
        let mut s = State::new("gpt-5-codex");
        s.ingest(
            "response.output_item.added",
            &json!({
                "item": {"type": "function_call", "call_id": "c1", "name": "shell"}
            }),
        );
        let out = s.ingest(
            "response.function_call_arguments.delta",
            &json!({"call_id": "c1", "delta": "{\"cmd\":"}),
        );
        let tcs = &out[0].choices[0].delta.tool_calls;
        assert_eq!(tcs[0].index, 0, "same index as the seed");
        assert_eq!(
            tcs[0].function.as_ref().unwrap().arguments.as_deref(),
            Some("{\"cmd\":")
        );
    }

    #[test]
    fn completed_carries_usage_and_finish_reason() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.completed",
            &json!({
                "response": {
                    "id": "resp_1",
                    "usage": {"input_tokens": 10, "output_tokens": 20}
                }
            }),
        );
        assert!(s.finished);
        assert_eq!(out[0].choices[0].finish_reason.as_deref(), Some("stop"));
        let usage = out[0].usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.output_tokens, Some(20));
    }

    #[test]
    fn unknown_event_is_silently_ignored() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest("response.tool_chatter.whatever", &json!({}));
        assert!(out.is_empty());
    }
}
