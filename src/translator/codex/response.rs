

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::inference::{
    OpenAiChatRole, OpenAiChoice, OpenAiChunk, OpenAiDelta, OpenAiToolCallDelta,
    OpenAiToolCallFunctionDelta, OpenAiUsage,
};

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
            "response.output_item.added" | "response.output_item.done" => {

                let item = &payload["item"];
                let item_type = item["type"].as_str().unwrap_or("");
                match item_type {
                    "function_call" if event == "response.output_item.added" => {
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
                            ..Default::default()
                        })]
                    }
                    // Codex `/responses` server-side web_search: emits a
                    // `web_search_call` output item whose `action` describes
                    // what the model searched for. Surface it as a synthetic
                    // text-content delta so the transcript shows the query.
                    // Shape reference: openai/codex
                    // codex-rs/protocol/src/models.rs:555-565 (WebSearchCall)
                    // codex-rs/protocol/src/models.rs:861-889 (WebSearchAction)
                    "web_search_call" if event == "response.output_item.done" => {
                        let note = format_web_search_call(item);
                        if note.is_empty() {
                            Vec::new()
                        } else {
                            vec![self.chunk_with_delta(OpenAiDelta {
                                role: None,
                                content: Some(note),
                                tool_calls: Vec::new(),
                                ..Default::default()
                            })]
                        }
                    }
                    _ => Vec::new(),
                }
            }
            "response.output_text.delta" => {
                if let Some(delta) = payload["delta"].as_str() {
                    vec![self.chunk_with_delta(OpenAiDelta {
                        role: None,
                        content: Some(delta.to_string()),
                        tool_calls: Vec::new(),
                        ..Default::default()
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
                        ..Default::default()
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
                    ..Default::default()
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

/// Render a `web_search_call` output item as a human-readable log line.
/// Shape: `{"type":"web_search_call","status":"completed",
///          "action":{"type":"search","query":"..."}}` — see openai/codex
/// codex-rs/protocol/src/models.rs:555-565.
fn format_web_search_call(item: &Value) -> String {
    let action = &item["action"];
    let action_type = action["type"].as_str().unwrap_or("");
    let status = item["status"].as_str().unwrap_or("");
    let body = match action_type {
        "search" => {
            let q = action["query"].as_str().unwrap_or("").to_string();
            let queries = action["queries"]
                .as_array()
                .map(|xs| xs.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            let detail = if !q.is_empty() {
                q
            } else if let Some(first) = queries.first() {
                if queries.len() > 1 {
                    format!("{first} ...")
                } else {
                    first.to_string()
                }
            } else {
                return String::new();
            };
            format!("web_search: {detail}")
        }
        "open_page" => {
            let url = action["url"].as_str().unwrap_or("");
            if url.is_empty() {
                return String::new();
            }
            format!("open_page: {url}")
        }
        "find_in_page" => {
            let url = action["url"].as_str().unwrap_or("");
            let pattern = action["pattern"].as_str().unwrap_or("");
            match (pattern.is_empty(), url.is_empty()) {
                (false, false) => format!("find_in_page: '{pattern}' in {url}"),
                (false, true) => format!("find_in_page: '{pattern}'"),
                (true, false) => format!("find_in_page: {url}"),
                (true, true) => return String::new(),
            }
        }
        _ => return String::new(),
    };
    if status.is_empty() || status == "completed" {
        format!("\n[{body}]\n")
    } else {
        format!("\n[{body} ({status})]\n")
    }
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

    #[test]
    fn web_search_call_done_emits_content_note() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_item.done",
            &json!({
                "item": {
                    "id": "ws_1",
                    "type": "web_search_call",
                    "status": "completed",
                    "action": {"type": "search", "query": "weather seattle"}
                }
            }),
        );
        assert_eq!(out.len(), 1);
        let content = out[0].choices[0].delta.content.as_deref().unwrap();
        assert!(content.contains("web_search"));
        assert!(content.contains("weather seattle"));
    }

    #[test]
    fn web_search_call_does_not_seed_tool_call() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_item.done",
            &json!({
                "item": {
                    "type": "web_search_call",
                    "status": "completed",
                    "action": {"type": "search", "query": "rust async"}
                }
            }),
        );
        assert!(out[0].choices[0].delta.tool_calls.is_empty(),
            "web_search_call must not emit a tool_call_delta; it's server-side");
    }

    #[test]
    fn web_search_call_added_event_is_ignored_only_done_emits() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_item.added",
            &json!({
                "item": {
                    "type": "web_search_call",
                    "status": "in_progress",
                    "action": {"type": "search", "query": "hello"}
                }
            }),
        );
        assert!(out.is_empty(),
            "we surface web_search_call at `done`, not `added`, to avoid partial renders");
    }

    #[test]
    fn open_page_action_emits_url_note() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_item.done",
            &json!({
                "item": {
                    "type": "web_search_call",
                    "status": "open",
                    "action": {"type": "open_page", "url": "https://example.com"}
                }
            }),
        );
        let content = out[0].choices[0].delta.content.as_deref().unwrap();
        assert!(content.contains("open_page"));
        assert!(content.contains("https://example.com"));
        assert!(content.contains("open")); // status rendered
    }

    #[test]
    fn find_in_page_renders_pattern_and_url() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_item.done",
            &json!({
                "item": {
                    "type": "web_search_call",
                    "status": "completed",
                    "action": {"type": "find_in_page", "url": "https://docs.rs", "pattern": "spawn"}
                }
            }),
        );
        let content = out[0].choices[0].delta.content.as_deref().unwrap();
        assert!(content.contains("find_in_page"));
        assert!(content.contains("spawn"));
        assert!(content.contains("docs.rs"));
    }

    #[test]
    fn web_search_call_queries_array_fallback() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_item.done",
            &json!({
                "item": {
                    "type": "web_search_call",
                    "status": "completed",
                    "action": {
                        "type": "search",
                        "queries": ["a", "b", "c"]
                    }
                }
            }),
        );
        let content = out[0].choices[0].delta.content.as_deref().unwrap();
        assert!(content.contains("a ..."),
            "when `query` is absent and there are multiple queries, render first with ellipsis");
    }

    #[test]
    fn unknown_web_search_action_type_emits_no_note() {
        let mut s = State::new("gpt-5-codex");
        let out = s.ingest(
            "response.output_item.done",
            &json!({
                "item": {
                    "type": "web_search_call",
                    "action": {"type": "new_upcoming_action"}
                }
            }),
        );
        assert!(out.is_empty());
    }

    #[test]
    fn function_call_done_without_added_does_not_double_seed() {
        let mut s = State::new("gpt-5-codex");
        // `added` seeds the tool_call
        let _ = s.ingest(
            "response.output_item.added",
            &json!({"item": {"type": "function_call", "call_id": "c1", "name": "shell"}}),
        );
        // `done` for the same function_call should NOT re-seed (no emission).
        let out = s.ingest(
            "response.output_item.done",
            &json!({"item": {"type": "function_call", "call_id": "c1", "name": "shell"}}),
        );
        assert!(out.is_empty(),
            "function_call.done must not re-seed; only `added` opens the tool_call");
    }
}
