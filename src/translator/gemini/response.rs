
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
    pub tool_call_names: Vec<String>,
    pub finished: bool,
    pub role_emitted: bool,
}

impl State {
    pub fn new(model_hint: &str) -> Self {
        Self {
            response_id: None,
            model: model_hint.to_string(),
            tool_call_names: Vec::new(),
            finished: false,
            role_emitted: false,
        }
    }

    fn register_tool_call(&mut self, name: &str) -> usize {
        if let Some(pos) = self.tool_call_names.iter().position(|c| c == name) {
            return pos;
        }
        self.tool_call_names.push(name.to_string());
        self.tool_call_names.len() - 1
    }

    pub fn ingest(&mut self, payload: &Value) -> Vec<OpenAiChunk> {
        if self.finished {
            return Vec::new();
        }
        let response = payload.get("response").unwrap_or(payload);

        if let Some(id) = payload.get("traceId").and_then(Value::as_str) {
            if self.response_id.is_none() {
                self.response_id = Some(id.to_string());
            }
        }
        if let Some(m) = response.get("modelVersion").and_then(Value::as_str) {
            if !m.is_empty() {
                self.model = m.to_string();
            }
        }

        let mut out: Vec<OpenAiChunk> = Vec::new();
        if !self.role_emitted {
            out.push(self.first_chunk());
            self.role_emitted = true;
        }

        let candidates = response
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut finish_reason: Option<String> = None;

        for cand in &candidates {
            let parts = cand
                .get("content")
                .and_then(|c| c.get("parts"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            for part in &parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        let is_thought = part
                            .get("thought")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        if is_thought {
                            out.push(self.chunk_with_delta(OpenAiDelta {
                                reasoning_content: Some(text.to_string()),
                                ..Default::default()
                            }));
                        } else {
                            out.push(self.chunk_with_delta(OpenAiDelta {
                                content: Some(text.to_string()),
                                ..Default::default()
                            }));
                        }
                    }
                    continue;
                }
                if let Some(fc) = part.get("functionCall") {
                    let name = fc
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let args = fc
                        .get("args")
                        .cloned()
                        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                    let args_str = serde_json::to_string(&args).unwrap_or_else(|_| "{}".into());
                    let index = self.register_tool_call(&name) as u32;
                    let call_id = format!("call_{}", index);
                    out.push(self.chunk_with_delta(OpenAiDelta {
                        tool_calls: vec![OpenAiToolCallDelta {
                            index,
                            id: Some(call_id),
                            kind: Some("function".to_string()),
                            function: Some(OpenAiToolCallFunctionDelta {
                                name: Some(name),
                                arguments: Some(args_str),
                            }),
                        }],
                        ..Default::default()
                    }));
                }
            }

            if let Some(fr) = cand.get("finishReason").and_then(Value::as_str) {
                if !fr.is_empty() && fr != "FINISH_REASON_UNSPECIFIED" {
                    finish_reason = Some(map_finish_reason(fr, &self.tool_call_names));
                }
            }
        }

        if let Some(reason) = finish_reason {
            self.finished = true;
            let usage = response.get("usageMetadata").cloned();
            out.push(self.final_chunk(usage, Some(reason)));
        }

        out
    }

    fn first_chunk(&self) -> OpenAiChunk {
        OpenAiChunk {
            id: self.response_id.clone().unwrap_or_else(|| "gemini".into()),
            object: OpenAiChunk::OBJECT.to_string(),
            created: now_secs(),
            model: self.model.clone(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    role: Some(OpenAiChatRole::Assistant),
                    ..Default::default()
                },
                finish_reason: None,
            }],
            usage: None,
        }
    }

    fn chunk_with_delta(&self, delta: OpenAiDelta) -> OpenAiChunk {
        OpenAiChunk {
            id: self.response_id.clone().unwrap_or_else(|| "gemini".into()),
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

    fn final_chunk(&self, usage: Option<Value>, finish_reason: Option<String>) -> OpenAiChunk {
        let usage_out = usage.as_ref().map(|u| OpenAiUsage {
            input_tokens: u.get("promptTokenCount").and_then(Value::as_u64),
            output_tokens: u.get("candidatesTokenCount").and_then(Value::as_u64),
        });
        OpenAiChunk {
            id: self.response_id.clone().unwrap_or_else(|| "gemini".into()),
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

fn map_finish_reason(gemini_reason: &str, tool_calls: &[String]) -> String {
    match gemini_reason {
        "STOP" => {
            if tool_calls.is_empty() {
                "stop".to_string()
            } else {
                "tool_calls".to_string()
            }
        }
        "MAX_TOKENS" => "length".to_string(),
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => {
            "content_filter".to_string()
        }
        "MALFORMED_FUNCTION_CALL" => "error".to_string(),
        "LANGUAGE" | "OTHER" => "stop".to_string(),
        _ => "stop".to_string(),
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
    fn first_ingest_emits_role_assistant_seed() {
        let mut s = State::new("gemini-3-pro-preview");
        let out = s.ingest(&json!({
            "response": {
                "candidates": [{"content": {"role": "model", "parts": [{"text": "hello"}]}}]
            }
        }));
        assert!(out.len() >= 2);
        assert_eq!(out[0].choices[0].delta.role, Some(OpenAiChatRole::Assistant));
        assert_eq!(out[1].choices[0].delta.content.as_deref(), Some("hello"));
    }

    #[test]
    fn second_ingest_does_not_re_emit_role() {
        let mut s = State::new("gemini-3-pro-preview");
        s.ingest(&json!({
            "response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "a"}]}}]}
        }));
        let out = s.ingest(&json!({
            "response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "b"}]}}]}
        }));
        assert_eq!(out.len(), 1);
        assert!(out[0].choices[0].delta.role.is_none());
        assert_eq!(out[0].choices[0].delta.content.as_deref(), Some("b"));
    }

    #[test]
    fn trace_id_seeds_response_id() {
        let mut s = State::new("gemini-3-pro-preview");
        s.ingest(&json!({
            "traceId": "trace-xyz",
            "response": {"candidates": [{"content": {"parts": [{"text": "x"}]}}]}
        }));
        assert_eq!(s.response_id.as_deref(), Some("trace-xyz"));
    }

    #[test]
    fn function_call_part_emits_tool_call_delta_with_serialized_args() {
        let mut s = State::new("gemini-3-pro-preview");
        let out = s.ingest(&json!({
            "response": {
                "candidates": [{
                    "content": {"parts": [{
                        "functionCall": {"name": "Glob", "args": {"pattern": "*.rs"}}
                    }]}
                }]
            }
        }));
        let tc_chunk = out.iter().find(|c| !c.choices[0].delta.tool_calls.is_empty()).unwrap();
        let tc = &tc_chunk.choices[0].delta.tool_calls[0];
        assert_eq!(tc.function.as_ref().unwrap().name.as_deref(), Some("Glob"));
        let args = tc.function.as_ref().unwrap().arguments.as_deref().unwrap();
        assert!(args.contains("*.rs"));
    }

    #[test]
    fn same_tool_call_name_reuses_index() {
        let mut s = State::new("gemini-3-pro-preview");
        s.ingest(&json!({
            "response": {"candidates": [{"content": {"parts": [{
                "functionCall": {"name": "Glob", "args": {}}
            }]}}]}
        }));
        let out = s.ingest(&json!({
            "response": {"candidates": [{"content": {"parts": [{
                "functionCall": {"name": "Glob", "args": {"pattern": "*.md"}}
            }]}}]}
        }));
        let tc = &out[0].choices[0].delta.tool_calls[0];
        assert_eq!(tc.index, 0);
    }

    #[test]
    fn finish_reason_stop_without_tool_calls_maps_to_stop() {
        let mut s = State::new("gemini-3-pro-preview");
        let out = s.ingest(&json!({
            "response": {
                "candidates": [{"finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 20}
            }
        }));
        let last = out.last().unwrap();
        assert_eq!(last.choices[0].finish_reason.as_deref(), Some("stop"));
        let usage = last.usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.output_tokens, Some(20));
    }

    #[test]
    fn finish_reason_stop_with_tool_calls_maps_to_tool_calls() {
        let mut s = State::new("gemini-3-pro-preview");
        s.ingest(&json!({
            "response": {"candidates": [{
                "content": {"parts": [{
                    "functionCall": {"name": "Glob", "args": {}}
                }]}
            }]}
        }));
        let out = s.ingest(&json!({
            "response": {"candidates": [{"finishReason": "STOP"}]}
        }));
        let last = out.last().unwrap();
        assert_eq!(
            last.choices[0].finish_reason.as_deref(),
            Some("tool_calls"),
            "agent loop gates dispatch on tool_calls; must infer from registered tool_call_names"
        );
    }

    #[test]
    fn max_tokens_finish_maps_to_length() {
        let mut s = State::new("m");
        let out = s.ingest(&json!({
            "response": {"candidates": [{"finishReason": "MAX_TOKENS"}]}
        }));
        assert_eq!(out.last().unwrap().choices[0].finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn safety_finish_maps_to_content_filter() {
        let mut s = State::new("m");
        let out = s.ingest(&json!({
            "response": {"candidates": [{"finishReason": "SAFETY"}]}
        }));
        assert_eq!(out.last().unwrap().choices[0].finish_reason.as_deref(), Some("content_filter"));
    }

    #[test]
    fn malformed_function_call_maps_to_error() {
        let mut s = State::new("m");
        let out = s.ingest(&json!({
            "response": {"candidates": [{"finishReason": "MALFORMED_FUNCTION_CALL"}]}
        }));
        assert_eq!(out.last().unwrap().choices[0].finish_reason.as_deref(), Some("error"));
    }

    #[test]
    fn thought_text_part_routes_to_reasoning_content() {
        let mut s = State::new("gemini-3-pro-preview");
        let out = s.ingest(&json!({
            "response": {"candidates": [{
                "content": {"parts": [{"text": "pondering…", "thought": true}]}
            }]}
        }));
        let chunk = out.iter().find(|c| c.choices[0].delta.reasoning_content.is_some()).unwrap();
        assert_eq!(chunk.choices[0].delta.reasoning_content.as_deref(), Some("pondering…"));
        assert!(chunk.choices[0].delta.content.is_none());
    }

    #[test]
    fn empty_text_part_is_filtered() {
        let mut s = State::new("m");
        let out = s.ingest(&json!({
            "response": {"candidates": [{"content": {"parts": [{"text": ""}]}}]}
        }));
        let any_content = out.iter().any(|c| c.choices[0].delta.content.is_some());
        assert!(!any_content, "empty text part must not emit content delta");
    }

    #[test]
    fn model_version_overrides_hint() {
        let mut s = State::new("gemini-fallback");
        s.ingest(&json!({
            "response": {
                "modelVersion": "gemini-3-pro-preview-v1",
                "candidates": [{"content": {"parts": [{"text": "hi"}]}}]
            }
        }));
        assert_eq!(s.model, "gemini-3-pro-preview-v1");
    }

    #[test]
    fn ingest_ignores_events_after_finish() {
        let mut s = State::new("m");
        let _ = s.ingest(&json!({
            "response": {"candidates": [{"finishReason": "STOP"}]}
        }));
        assert!(s.finished);
        let out = s.ingest(&json!({
            "response": {"candidates": [{"content": {"parts": [{"text": "late"}]}}]}
        }));
        assert!(out.is_empty(), "post-finish events must be ignored");
    }
}
