//! Translator — OpenAI canonical request → ChatGPT `/v1/responses`
//! body. Mirrors `codex-rs/codex-api/src/common.rs :: ResponsesApiRequest`.
//!
//! # Shape
//!
//! ```json
//! {
//!   "model": "gpt-5-codex",
//!   "instructions": "<system prompt>",
//!   "input": [
//!     {"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}
//!   ],
//!   "tools": [ /* codex-native tool defs */ ],
//!   "tool_choice": "auto",
//!   "parallel_tool_calls": true,
//!   "reasoning": {"effort":"medium","summary":"auto"},
//!   "store": true,
//!   "stream": true
//! }
//! ```
//!
//! Unlike the anthropic translator, codex's `/responses` consumes a
//! flat `input[]` array of polymorphic items (`message`, `function_call`,
//! `function_call_output`, `reasoning`) — not a `messages[]` of role
//! strings + plain content. We map OpenAI-canonical history into the
//! codex shape on each outbound turn.

use serde_json::{json, Map, Value};

use crate::inference::{OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole};
use crate::thinking::{ThinkingConfig, ThinkingLevel, ThinkingMode};

/// Build the full `/responses` body. `tools_json` is the already-
/// assembled tool array (codex-native schemas); `instructions` is the
/// optional system prompt.
pub fn build_responses_body(
    req: &OpenAiChatRequest,
    tools_json: Vec<Value>,
    thinking: Option<&ThinkingConfig>,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(req.model.clone()));
    if let Some(instr) = extract_instructions(&req.messages) {
        body.insert("instructions".into(), Value::String(instr));
    }
    body.insert("input".into(), Value::Array(messages_to_input(&req.messages)));
    if !tools_json.is_empty() {
        body.insert("tools".into(), Value::Array(tools_json));
        body.insert("tool_choice".into(), Value::String("auto".into()));
        body.insert("parallel_tool_calls".into(), Value::Bool(true));
    }
    if let Some(reasoning) = thinking.and_then(reasoning_json) {
        body.insert("reasoning".into(), reasoning);
    }
    // `store: true` enables previous_response_id continuity server-side.
    // We don't use `previous_response_id` on the SSE path today — every
    // turn replays the full input — but keeping store=true matches
    // upstream parity and unlocks the WebSocket path later.
    body.insert("store".into(), Value::Bool(true));
    body.insert("stream".into(), Value::Bool(true));
    body.insert("include".into(), Value::Array(Vec::new()));
    Value::Object(body)
}

/// Pull the first `system` message out and return its plain text — the
/// codex `/responses` envelope expects the system prompt on the
/// top-level `instructions` field, NOT as an input item.
fn extract_instructions(messages: &[OpenAiChatMessage]) -> Option<String> {
    for msg in messages {
        if matches!(msg.role, OpenAiChatRole::System) && !msg.content.is_empty() {
            return Some(msg.content.clone());
        }
    }
    None
}

/// Convert the rest of the history into `input[]` items. System
/// messages (already pulled onto `instructions`) are skipped; tool
/// results go in as `function_call_output`; assistant messages with
/// tool_calls become `function_call` items.
fn messages_to_input(messages: &[OpenAiChatMessage]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for msg in messages {
        match msg.role {
            OpenAiChatRole::System => {} // already on instructions
            OpenAiChatRole::User => {
                out.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": msg.content}],
                }));
            }
            OpenAiChatRole::Assistant => {
                if !msg.content.is_empty() {
                    out.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": msg.content}],
                    }));
                }
                for tc in &msg.tool_calls {
                    out.push(json!({
                        "type": "function_call",
                        "call_id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    }));
                }
            }
            OpenAiChatRole::Tool => {
                let call_id = msg.tool_call_id.clone().unwrap_or_default();
                out.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": msg.content,
                }));
            }
        }
    }
    out
}

/// Map our `ThinkingConfig` into the codex `reasoning` envelope. Codex
/// accepts `effort: low|medium|high` only — `minimal`/`xhigh`/`max`
/// collapse to the closest allowed value. `auto` / `none` drop the
/// reasoning envelope entirely.
fn reasoning_json(cfg: &ThinkingConfig) -> Option<Value> {
    if matches!(cfg.mode, ThinkingMode::None | ThinkingMode::Auto) {
        return None;
    }
    let effort = match cfg.level {
        ThinkingLevel::Minimal | ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High | ThinkingLevel::XHigh | ThinkingLevel::Max => "high",
        ThinkingLevel::None | ThinkingLevel::Auto => return None,
    };
    Some(json!({
        "effort": effort,
        "summary": "auto",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::OpenAiChatMessage;

    fn user(content: &str) -> OpenAiChatMessage {
        OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: content.into(),
            ..Default::default()
        }
    }

    fn system(content: &str) -> OpenAiChatMessage {
        OpenAiChatMessage {
            role: OpenAiChatRole::System,
            content: content.into(),
            ..Default::default()
        }
    }

    #[test]
    fn body_lifts_system_to_instructions() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![system("you are a helper"), user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        assert_eq!(body["instructions"], "you are a helper");
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "message");
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[0]["content"][0]["text"], "hi");
    }

    #[test]
    fn body_encodes_stream_and_store() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], true);
        assert!(body["include"].as_array().unwrap().is_empty());
    }

    #[test]
    fn body_attaches_tools_and_tool_choice() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let tool = json!({
            "type": "function",
            "name": "shell",
            "description": "",
            "strict": false,
            "parameters": {"type": "object", "properties": {}}
        });
        let body = build_responses_body(&req, vec![tool], None);
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["parallel_tool_calls"], true);
    }

    #[test]
    fn body_drops_tool_choice_when_no_tools() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn body_maps_thinking_level_to_effort() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(
            &req,
            vec![],
            Some(&ThinkingConfig::level(ThinkingLevel::XHigh)),
        );
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["reasoning"]["summary"], "auto");
    }

    #[test]
    fn body_drops_reasoning_on_auto_or_none() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], Some(&ThinkingConfig::auto()));
        assert!(body.get("reasoning").is_none());
        let body = build_responses_body(&req, vec![], Some(&ThinkingConfig::none()));
        assert!(body.get("reasoning").is_none());
    }

    #[test]
    fn assistant_tool_call_becomes_function_call_item() {
        let mut asst = OpenAiChatMessage::default();
        asst.role = OpenAiChatRole::Assistant;
        asst.content = "".into();
        asst.tool_calls.push(crate::inference::OpenAiToolCall {
            id: "call-1".into(),
            kind: "function".into(),
            function: crate::inference::OpenAiToolCallFunction {
                name: "shell".into(),
                arguments: r#"{"command":["ls"]}"#.into(),
            },
        });
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![asst],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["call_id"], "call-1");
        assert_eq!(input[0]["name"], "shell");
    }

    #[test]
    fn tool_role_becomes_function_call_output() {
        let msg = OpenAiChatMessage {
            role: OpenAiChatRole::Tool,
            content: "exit=0\nhello".into(),
            tool_call_id: Some("call-1".into()),
            ..Default::default()
        };
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![msg],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        let input = body["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "function_call_output");
        assert_eq!(input[0]["call_id"], "call-1");
        assert_eq!(input[0]["output"], "exit=0\nhello");
    }
}
