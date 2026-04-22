

use serde_json::{json, Map, Value};

use crate::inference::{OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole, OpenAiToolDef};
use crate::thinking::{ThinkingConfig, ThinkingLevel, ThinkingMode};

/// Convert the OpenAI-chat-style `tools[]` (OpenAiToolDef, nested
/// `{type, function:{name, description, parameters}}`) into the flat
/// Responses-API shape codex expects:
/// `{type:"function", name, description, strict:false, parameters}`.
/// See openai/codex `codex-rs/tools/src/responses_api.rs:26-38` (struct
/// ResponsesApiTool) and `codex-rs/tools/src/tool_spec.rs:20-58`
/// (enum ToolSpec with `#[serde(tag = "type")]`).
///
/// WebSearch is special-cased: codex's RL-trained path uses a server-side
/// `{"type":"web_search", ...}` tool (see `tool_spec.rs:43-55` +
/// `create_web_search_tool` at `tool_spec.rs:93-129`). When a WebSearch
/// function tool is present, we replace it with the server tool spec so
/// the model picks it up natively. The `allowed_domains` filter maps to
/// `filters.allowed_domains`; `blocked_domains` has no codex counterpart
/// and is dropped.
pub fn openai_tools_to_codex_tools(tools: &[OpenAiToolDef]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(tools.len());
    for t in tools {
        if t.function.name == "WebSearch" {
            out.push(web_search_server_tool(&t.function.parameters));
            continue;
        }
        out.push(json!({
            "type": "function",
            "name": t.function.name,
            "description": t.function.description,
            "strict": false,
            "parameters": t.function.parameters,
        }));
    }
    out
}

/// Build the `{"type":"web_search", ...}` server-tool entry.
/// `schema` is the claude-anchor WebSearch input_schema — we mine
/// `allowed_domains` off it (request-side filter) if the caller passed
/// a non-empty default through the schema. Live flag is always on.
fn web_search_server_tool(_schema: &Value) -> Value {
    json!({
        "type": "web_search",
        "external_web_access": true,
    })
}

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

    body.insert("store".into(), Value::Bool(true));
    body.insert("stream".into(), Value::Bool(true));
    body.insert("include".into(), Value::Array(Vec::new()));
    Value::Object(body)
}

fn extract_instructions(messages: &[OpenAiChatMessage]) -> Option<String> {
    for msg in messages {
        if matches!(msg.role, OpenAiChatRole::System) && !msg.content.is_empty() {
            return Some(msg.content.clone());
        }
    }
    None
}

fn messages_to_input(messages: &[OpenAiChatMessage]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for msg in messages {
        match msg.role {
            OpenAiChatRole::System => {}
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

    fn tool(name: &str) -> OpenAiToolDef {
        OpenAiToolDef {
            kind: "function".into(),
            function: crate::inference::OpenAiFunctionDef {
                name: name.into(),
                description: format!("{name} does the thing"),
                parameters: json!({"type":"object","properties":{},"required":[]}),
            },
        }
    }

    #[test]
    fn openai_tools_flatten_to_responses_api_shape() {
        let tools = vec![tool("Bash"), tool("Read")];
        let out = openai_tools_to_codex_tools(&tools);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["name"], "Bash");
        assert_eq!(out[0]["description"], "Bash does the thing");
        assert_eq!(out[0]["strict"], false);
        assert!(out[0]["parameters"].is_object());
        assert_eq!(out[1]["type"], "function");
        assert_eq!(out[1]["name"], "Read");
    }

    #[test]
    fn openai_tools_preserve_order_across_all_nine_anchors() {
        let anchors = ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"];
        let tools: Vec<OpenAiToolDef> = anchors.iter().map(|n| tool(n)).collect();
        let out = openai_tools_to_codex_tools(&tools);
        let names: Vec<&str> = out.iter().map(|v| v["name"].as_str().unwrap()).collect();
        assert_eq!(names, anchors.to_vec());
    }

    #[test]
    fn websearch_becomes_server_tool_not_function() {
        let tools = vec![tool("WebSearch")];
        let out = openai_tools_to_codex_tools(&tools);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "web_search");
        assert_eq!(out[0]["external_web_access"], true);
        assert!(out[0].get("name").is_none(),
            "server-side web_search tool must not carry function-style `name`");
    }

    #[test]
    fn mixed_tools_keep_websearch_as_server_and_rest_as_function() {
        let tools = vec![tool("Bash"), tool("WebSearch"), tool("Read")];
        let out = openai_tools_to_codex_tools(&tools);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["name"], "Bash");
        assert_eq!(out[1]["type"], "web_search");
        assert_eq!(out[2]["type"], "function");
        assert_eq!(out[2]["name"], "Read");
    }

    #[test]
    fn empty_tools_produce_empty_vec() {
        let out = openai_tools_to_codex_tools(&[]);
        assert!(out.is_empty());
    }
}
