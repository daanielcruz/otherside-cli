
use serde_json::{json, Map, Value};

use crate::harness::reminders::render_user_context_with_git;
use crate::harness::REMINDER_SKILLS;
use crate::inference::{OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole, OpenAiToolDef};
use crate::thinking::{ThinkingConfig, ThinkingLevel, ThinkingMode};
use crate::translator::anthropic::UserContext;

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

fn web_search_server_tool(_schema: &Value) -> Value {
    json!({
        "type": "web_search",
        "external_web_access": true,
    })
}

pub const DEFAULT_INSTRUCTIONS: &str =
    "You are Codex, a coding agent based on GPT-5. You and the user share the same workspace and collaborate to achieve the user's goals.";

fn claude_harness_instructions() -> String {
    let preamble = crate::harness::SYSTEM_AGENT_PREAMBLE.trim_end();
    let main = crate::harness::SYSTEM_PROMPT.trim_end();
    format!("{preamble}\n\n{main}")
}

fn codex_deferred_tools_reminder() -> String {
    crate::harness::reminders::third_party_deferred_tools_reminder()
}

pub fn build_responses_body(
    req: &OpenAiChatRequest,
    tools_json: Vec<Value>,
    thinking: Option<&ThinkingConfig>,
) -> Value {
    build_responses_body_with_ctx(req, tools_json, thinking, None, None)
}

pub fn build_responses_body_with_ctx(
    req: &OpenAiChatRequest,
    tools_json: Vec<Value>,
    thinking: Option<&ThinkingConfig>,
    user_ctx: Option<&UserContext<'_>>,
    service_tier: Option<&str>,
) -> Value {
    build_responses_body_full(req, tools_json, thinking, user_ctx, service_tier, None, 1, false)
}

pub fn build_responses_body_full(
    req: &OpenAiChatRequest,
    tools_json: Vec<Value>,
    thinking: Option<&ThinkingConfig>,
    user_ctx: Option<&UserContext<'_>>,
    service_tier: Option<&str>,
    previous_response_id: Option<&str>,
    turn: u32,
    is_subagent: bool,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(req.model.clone()));

    let harness = claude_harness_instructions();
    let extra = extract_instructions(&req.messages);
    let instructions = match extra {
        Some(s) if !s.is_empty() => format!("{harness}\n\n{s}"),
        _ if !harness.is_empty() => harness,
        _ => DEFAULT_INSTRUCTIONS.to_string(),
    };
    body.insert("instructions".into(), Value::String(instructions));
    body.insert(
        "input".into(),
        Value::Array(messages_to_input(&req.messages, user_ctx)),
    );
    if !tools_json.is_empty() {
        body.insert("tools".into(), Value::Array(tools_json));
        let tool_choice = req
            .tool_choice
            .clone()
            .unwrap_or_else(|| Value::String("auto".into()));
        body.insert("tool_choice".into(), tool_choice);
        body.insert("parallel_tool_calls".into(), Value::Bool(true));
    }
    if let Some(reasoning) = thinking.and_then(reasoning_json) {
        body.insert("reasoning".into(), reasoning);
    }
    if let Some(tier) = service_tier {
        body.insert("service_tier".into(), Value::String(tier.to_string()));
    }

    let _ = previous_response_id;

    body.insert(
        "client_metadata".into(),
        json!({
            "program": "codex",
            "originator": crate::fingerprint::codex::ORIGINATOR,
            "turn": turn.to_string(),
            "subagent": is_subagent.to_string(),
        }),
    );

    body.insert("store".into(), Value::Bool(false));
    body.insert("stream".into(), Value::Bool(true));
    let include = if thinking.and_then(reasoning_json).is_some() {
        vec![Value::String("reasoning.encrypted_content".into())]
    } else {
        Vec::new()
    };
    body.insert("include".into(), Value::Array(include));
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

fn messages_to_input(
    messages: &[OpenAiChatMessage],
    user_ctx: Option<&UserContext<'_>>,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut first_user = true;
    for msg in messages {
        match msg.role {
            OpenAiChatRole::System => {}
            OpenAiChatRole::User => {
                if first_user {
                    if let Some(ctx) = user_ctx {

                        out.push(json!({
                            "type": "message",
                            "role": "developer",
                            "content": [{
                                "type": "input_text",
                                "text": codex_deferred_tools_reminder(),
                            }],
                        }));
                        out.push(json!({
                            "type": "message",
                            "role": "developer",
                            "content": [{
                                "type": "input_text",
                                "text": REMINDER_SKILLS,
                            }],
                        }));

                        out.push(json!({
                            "type": "message",
                            "role": "user",
                            "content": [{
                                "type": "input_text",
                                "text": render_user_context_with_git(
                                    ctx.email,
                                    ctx.current_date,
                                    ctx.git_status,
                                ),
                            }],
                        }));
                    }
                    first_user = false;
                }
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
                    let mut fc = Map::new();
                    fc.insert("type".into(), Value::String("function_call".into()));
                    fc.insert("call_id".into(), Value::String(tc.id.clone()));
                    fc.insert("name".into(), Value::String(tc.function.name.clone()));
                    fc.insert(
                        "arguments".into(),
                        Value::String(tc.function.arguments.clone()),
                    );
                    fc.insert("status".into(), Value::String("completed".into()));
                    out.push(Value::Object(fc));
                }
            }
            OpenAiChatRole::Tool => {
                let call_id = msg.tool_call_id.clone().unwrap_or_default();
                let output_value: Value = match serde_json::from_str::<Value>(&msg.content) {
                    Ok(Value::Array(arr))
                        if arr.iter().all(|v| v.is_object()) =>
                    {
                        Value::Array(arr)
                    }
                    _ => Value::String(msg.content.clone()),
                };
                out.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output_value,
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
        ThinkingLevel::High => "high",
        ThinkingLevel::XHigh | ThinkingLevel::Max => "xhigh",
        
        ThinkingLevel::On => "xhigh",
        ThinkingLevel::Off => return None,
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

    fn user_ctx() -> UserContext<'static> {
        UserContext {
            email: "user@example.com",
            current_date: "2026-04-22",
            cwd: "/tmp/smoke",
            is_git_repo: true,
            platform: "darwin",
            shell: "zsh",
            os_version: "Darwin 25.3.0",
            memory_dir: "/tmp/smoke/memory/",
            git_status: "Current branch: main\n\nStatus:\n(clean)",
        }
    }

    #[test]
    fn body_with_ctx_splits_reminders_into_developer_and_user_messages() {

        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![
                user("first turn"),
                OpenAiChatMessage {
                    role: OpenAiChatRole::Assistant,
                    content: "ok".into(),
                    ..Default::default()
                },
                user("second turn"),
            ],
            ..Default::default()
        };
        let ctx = user_ctx();
        let body = build_responses_body_with_ctx(&req, vec![], None, Some(&ctx), None);
        let input = body["input"].as_array().unwrap();

        assert_eq!(
            input[0]["role"], "developer",
            "deferred-tools reminder must ride on a developer message, not user"
        );
        let deferred_text = input[0]["content"][0]["text"].as_str().unwrap();
        assert!(
            deferred_text.contains("<available-deferred-tools>"),
            "developer item 0 must carry the deferred-tools tag: {:?}",
            &deferred_text[..deferred_text.len().min(80)]
        );
        assert!(
            deferred_text.contains("ADDITIVE"),
            "codex deferred-tools reminder must prepend the additive clarifier"
        );
        assert!(
            deferred_text.contains("Do NOT refuse"),
            "codex deferred-tools reminder must explicitly forbid refusal"
        );

        assert_eq!(input[1]["role"], "developer");
        let skills_text = input[1]["content"][0]["text"].as_str().unwrap();
        assert!(
            skills_text.contains("</system-reminder>"),
            "developer item 1 must be skills reminder with closing system-reminder tag"
        );

        assert_eq!(
            input[2]["role"], "user",
            "contextual user item (email/date/git) must stay role=user so the model treats it as conversation context"
        );
        let ctx_text = input[2]["content"][0]["text"].as_str().unwrap();
        assert!(ctx_text.contains("user@example.com"));
        assert!(ctx_text.contains("2026-04-22"));
        assert!(ctx_text.contains("Current branch: main"));

        assert_eq!(input[3]["role"], "user");
        let first_real = input[3]["content"][0]["text"].as_str().unwrap();
        assert_eq!(first_real, "first turn");

        assert_eq!(
            input[5]["role"], "user",
            "second user turn must be plain user item, no reminder re-injection"
        );
        assert_eq!(input[5]["content"][0]["text"], "second turn");
    }

    #[test]
    fn body_without_ctx_keeps_legacy_shape_no_reminders() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        let input = body["input"].as_array().unwrap();
        assert_eq!(input[0]["content"].as_array().unwrap().len(), 1);
        assert_eq!(input[0]["content"][0]["text"], "hi");
    }

    #[test]
    fn body_appends_system_message_after_harness_instructions() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![system("you are a helper"), user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        let instr = body["instructions"].as_str().expect("instructions present");
        
        assert!(
            !instr.contains("x-anthropic-billing-header:"),
            "billing header leaked to codex: {instr}"
        );
        assert!(
            !instr.contains("You are Claude Code,"),
            "claude-code opener leaked to codex: {instr}"
        );
        assert!(
            instr.ends_with("you are a helper"),
            "caller system must be appended after harness: tail={:?}",
            &instr[instr.len().saturating_sub(40)..]
        );
        assert!(
            instr.len() > 15_000,
            "main system prompt (~16KB) must flow"
        );
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "message");
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[0]["content"][0]["text"], "hi");
    }

    #[test]
    fn body_still_carries_harness_when_no_system_message() {
        let req = OpenAiChatRequest {
            model: "gpt-5.4".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        let instr = body["instructions"].as_str().expect("instructions present");
        assert!(!instr.is_empty(), "upstream /responses rejects empty instructions");
        
        assert!(
            !instr.contains("x-anthropic-billing-header:"),
            "billing header leaked when no system message: {instr}"
        );
        assert!(
            !instr.contains("You are Claude Code,"),
            "claude-code opener leaked when no system message: {instr}"
        );
        assert!(
            instr.len() > 15_000,
            "main system prompt (~16KB) must flow by default"
        );
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
        assert_eq!(
            body["store"], false,
            "ChatGPT /responses rejects store:true — upstream only flips true on Azure"
        );
        assert!(body["include"].as_array().unwrap().is_empty());
    }

    #[test]
    fn body_opts_into_reasoning_encrypted_content_when_reasoning_enabled() {

        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(
            &req,
            vec![],
            Some(&ThinkingConfig::level(ThinkingLevel::High)),
        );
        let include = body["include"].as_array().unwrap();
        assert!(
            include.iter().any(|v| v == "reasoning.encrypted_content"),
            "reasoning-enabled request must opt into encrypted_content roundtrip: {include:?}"
        );
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
    fn body_respects_caller_tool_choice_required() {

        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            tool_choice: Some(json!("required")),
            ..Default::default()
        };
        let tool = json!({
            "type": "function", "name": "Bash", "description": "",
            "strict": false, "parameters": {"type":"object","properties":{}}
        });
        let body = build_responses_body(&req, vec![tool], None);
        assert_eq!(body["tool_choice"], "required");
    }

    #[test]
    fn body_respects_caller_tool_choice_specific_function() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            tool_choice: Some(json!({"type":"function","name":"Bash"})),
            ..Default::default()
        };
        let tool = json!({
            "type": "function", "name": "Bash", "description": "",
            "strict": false, "parameters": {"type":"object","properties":{}}
        });
        let body = build_responses_body(&req, vec![tool], None);
        assert_eq!(body["tool_choice"]["type"], "function");
        assert_eq!(body["tool_choice"]["name"], "Bash");
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
        assert_eq!(body["reasoning"]["effort"], "xhigh");
        assert_eq!(body["reasoning"]["summary"], "auto");
    }

    #[test]
    fn body_maps_high_separately_from_xhigh() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body_high = build_responses_body(
            &req,
            vec![],
            Some(&ThinkingConfig::level(ThinkingLevel::High)),
        );
        assert_eq!(
            body_high["reasoning"]["effort"], "high",
            "Codex now accepts low/medium/high/xhigh for all models (user-confirmed upstream contract). High and XHigh must not alias to the same effort string."
        );
    }

    #[test]
    fn body_maps_max_to_xhigh_as_alias() {
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_responses_body(
            &req,
            vec![],
            Some(&ThinkingConfig::level(ThinkingLevel::Max)),
        );
        assert_eq!(
            body["reasoning"]["effort"], "xhigh",
            "Codex caps out at xhigh — Max aliases to xhigh since the /responses surface has no separate max effort."
        );
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
    fn tool_role_becomes_function_call_output_string_passthrough() {
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

    #[test]
    fn tool_role_json_object_serialized_back_to_string() {

        let msg = OpenAiChatMessage {
            role: OpenAiChatRole::Tool,
            content: r#"{"status":"completed","agentId":"agent-a1b"}"#.into(),
            tool_call_id: Some("call-9".into()),
            ..Default::default()
        };
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![msg],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        let out = &body["input"].as_array().unwrap()[0]["output"];
        assert!(out.is_string(), "codex /responses rejects object output — must be serialized string");
        assert!(out.as_str().unwrap().contains("agent-a1b"));
    }

    #[test]
    fn tool_role_preserves_structured_json_array() {
        let msg = OpenAiChatMessage {
            role: OpenAiChatRole::Tool,
            content: r#"[{"path":"/a"},{"path":"/b"}]"#.into(),
            tool_call_id: Some("call-10".into()),
            ..Default::default()
        };
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![msg],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        let out = &body["input"].as_array().unwrap()[0]["output"];
        assert!(out.is_array());
        assert_eq!(out.as_array().unwrap().len(), 2);
    }

    #[test]
    fn assistant_tool_call_replay_includes_status_completed() {

        let mut asst = OpenAiChatMessage::default();
        asst.role = OpenAiChatRole::Assistant;
        asst.tool_calls.push(crate::inference::OpenAiToolCall {
            id: "call-r".into(),
            kind: "function".into(),
            function: crate::inference::OpenAiToolCallFunction {
                name: "Bash".into(),
                arguments: r#"{"command":"ls"}"#.into(),
            },
        });
        let req = OpenAiChatRequest {
            model: "gpt-5-codex".into(),
            messages: vec![asst],
            ..Default::default()
        };
        let body = build_responses_body(&req, vec![], None);
        let input = body["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["status"], "completed");
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
    fn websearch_announced_via_toolsearch_reaches_codex_as_server_tool() {

        crate::tools::deferred_registry::clear();
        crate::tools::deferred_registry::announce("WebSearch");
        let wire_tools = crate::tools::openai_tools();
        let codex_tools = openai_tools_to_codex_tools(&wire_tools);
        let web = codex_tools
            .iter()
            .find(|v| v["type"] == "web_search")
            .expect("after announce, WebSearch must reach codex tools[] as server-side web_search");
        assert_eq!(web["external_web_access"], true);
        crate::tools::deferred_registry::clear();
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
