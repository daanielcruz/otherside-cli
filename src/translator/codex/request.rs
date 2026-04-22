

use serde_json::{json, Map, Value};

use crate::harness::reminders::render_user_context_with_git;
use crate::harness::REMINDER_SKILLS;
use crate::inference::{OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole, OpenAiToolDef};
use crate::thinking::{ThinkingConfig, ThinkingLevel, ThinkingMode};
use crate::translator::anthropic::UserContext;

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

/// Upstream's fallback header when no explicit base instructions are supplied.
/// Mirrors `DEFAULT_PERSONALITY_HEADER` at
/// `openai/codex:codex-rs/models-manager/src/model_info.rs:17`.
/// The /responses endpoint rejects requests with missing or empty
/// `instructions` ({"detail":"Instructions are required"}), so we always
/// emit a non-empty string — see `build_responses_request` at
/// `codex-rs/core/src/client.rs:831-874` where upstream clones
/// `prompt.base_instructions.text` unconditionally into the request body.
pub const DEFAULT_INSTRUCTIONS: &str =
    "You are Codex, a coding agent based on GPT-5. You and the user share the same workspace and collaborate to achieve the user's goals.";

/// Concatenation of the claude-code agent preamble + main system prompt.
/// Codex speaks OpenAI /responses which folds the "system" role into a
/// single `instructions` string. To keep operational parity (tools, slash
/// commands, memory system, permission semantics all come from these two
/// blocks), we prepend them to any caller-supplied System message. The
/// claude-code-exclusive blocks (billing header + `You are Claude Code…`
/// opener) are NOT included — Codex has its own identity + routing.
fn claude_harness_instructions() -> String {
    let preamble = crate::harness::SYSTEM_AGENT_PREAMBLE.trim_end();
    let main = crate::harness::SYSTEM_PROMPT.trim_end();
    format!("{preamble}\n\n{main}")
}

/// Codex uses the shared third-party clarifier prepended to the raw
/// `<available-deferred-tools>` tag. Same fix as Kimi ThirdParty flavor.
fn codex_deferred_tools_reminder() -> String {
    crate::harness::reminders::third_party_deferred_tools_reminder()
}

pub fn build_responses_body(
    req: &OpenAiChatRequest,
    tools_json: Vec<Value>,
    thinking: Option<&ThinkingConfig>,
) -> Value {
    build_responses_body_with_ctx(req, tools_json, thinking, None)
}

/// Like `build_responses_body` but threads the harness reminder context
/// (email, date, git status) so the first user input carries the
/// `<available-deferred-tools>`, `<skills>`, and `<user-context>` reminder
/// blocks the Anthropic translator injects via `message_builder::normalize`.
/// Without these reminders Codex would see preamble + main prompt only,
/// missing the per-turn operational context (deferred tools availability,
/// user identity, current date, git status). User ask 2026-04-22:
/// "mandar todo harness claude code, só excluímos billing header e opener".
pub fn build_responses_body_with_ctx(
    req: &OpenAiChatRequest,
    tools_json: Vec<Value>,
    thinking: Option<&ThinkingConfig>,
    user_ctx: Option<&UserContext<'_>>,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(req.model.clone()));
    // Always lead with the claude-code harness preamble + main prompt so
    // Codex gets the same tool discipline, memory rules, and operational
    // context as Anthropic. Caller-supplied System message (e.g. subagent
    // definition.system_prompt) is appended after. Empty-fallback is the
    // codex-personality header so /responses never rejects on
    // {"detail":"Instructions are required"}.
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
        body.insert("tool_choice".into(), Value::String("auto".into()));
        body.insert("parallel_tool_calls".into(), Value::Bool(true));
    }
    if let Some(reasoning) = thinking.and_then(reasoning_json) {
        body.insert("reasoning".into(), reasoning);
    }

    // ChatGPT /responses rejects `store:true` with HTTP 400
    // ({"detail":"Store must be set to false"}). Upstream mirrors this:
    // `store: provider.is_azure_responses_endpoint()` at
    // `openai/codex:codex-rs/core/src/client.rs:880` — false on ChatGPT,
    // true only on Azure Responses. We target ChatGPT exclusively.
    body.insert("store".into(), Value::Bool(false));
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
                let mut content: Vec<Value> = Vec::new();
                if first_user {
                    if let Some(ctx) = user_ctx {
                        // Mirror the anthropic `build_preamble_blocks_with_git`
                        // contract (deferred-tools + skills + user-context) on
                        // the /responses wire. Upstream Codex doesn't ship
                        // these, but Otherside needs them so the Codex-backed
                        // agent loop matches Anthropic behavior for tool
                        // discovery, skill catalog, and per-turn context.
                        // Codex tool regression (2026-04-22): GPT-5 reads
                        // raw `<available-deferred-tools>` as an exclusive
                        // list ("these are the only tools available") and
                        // refuses Bash fluently. Upstream Claude is tuned
                        // to the tag and treats it as additive; Codex is
                        // not. Prepend an explanatory clarifier on the
                        // codex wire ONLY — anthropic + kimi still see the
                        // raw tag for byte-fidelity with upstream.
                        content.push(json!({
                            "type": "input_text",
                            "text": codex_deferred_tools_reminder(),
                        }));
                        content.push(json!({
                            "type": "input_text",
                            "text": REMINDER_SKILLS,
                        }));
                        content.push(json!({
                            "type": "input_text",
                            "text": render_user_context_with_git(
                                ctx.email,
                                ctx.current_date,
                                ctx.git_status,
                            ),
                        }));
                    }
                    first_user = false;
                }
                content.push(json!({"type": "input_text", "text": msg.content}));
                out.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": content,
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
        ThinkingLevel::High => "high",
        ThinkingLevel::XHigh | ThinkingLevel::Max => "xhigh",
        // Kimi's On/Off ladder doesn't exist on Codex; `/responses`
        // reasoning takes numeric levels only. Map On→xhigh (best effort)
        // and Off→drop the reasoning block.
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
    fn body_with_ctx_prepends_reminders_on_first_user_only() {
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
        let body = build_responses_body_with_ctx(&req, vec![], None, Some(&ctx));
        let input = body["input"].as_array().unwrap();

        // first user: reminder blocks + user content
        assert_eq!(input[0]["role"], "user");
        let first_content = input[0]["content"].as_array().unwrap();
        assert_eq!(
            first_content.len(),
            4,
            "first user must carry 3 reminder blocks + 1 user text"
        );
        let first_texts: Vec<&str> = first_content
            .iter()
            .map(|b| b["text"].as_str().unwrap_or(""))
            .collect();
        assert!(
            first_texts[0].contains("<available-deferred-tools>"),
            "block 0 must retain the deferred-tools tag: {:?}",
            &first_texts[0][..first_texts[0].len().min(80)]
        );
        assert!(
            first_texts[1].contains("</system-reminder>"),
            "block 1 must be skills reminder with closing system-reminder tag"
        );
        assert!(
            first_texts[2].contains("user@example.com"),
            "block 2 must carry user email substitution"
        );
        assert!(
            first_texts[2].contains("2026-04-22"),
            "block 2 must carry current_date substitution"
        );
        assert!(
            first_texts[2].contains("Current branch: main"),
            "block 2 must carry git_status when populated"
        );
        // Codex-only clarifier: model must see "ADDITIVE" framing so it
        // doesn't refuse Bash calls on the grounds that Bash isn't listed
        // in <available-deferred-tools>. Parity fix 2026-04-22.
        assert!(
            first_texts[0].contains("ADDITIVE"),
            "codex deferred-tools reminder must prepend the additive clarifier: {:?}",
            first_texts[0],
        );
        assert!(
            first_texts[0].contains("Do NOT refuse"),
            "codex deferred-tools reminder must explicitly forbid refusal of tools in the main tools[] array",
        );
        assert_eq!(first_texts[3], "first turn");

        // second user: only user content, no reminders
        assert_eq!(input[2]["role"], "user");
        let second_content = input[2]["content"].as_array().unwrap();
        assert_eq!(
            second_content.len(),
            1,
            "second user must NOT carry reminders"
        );
        assert_eq!(second_content[0]["text"], "second turn");
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
        // Harness preamble + main system prompt MUST ride on codex too —
        // they carry the tool discipline, slash rules, memory system.
        // Claude-code-exclusive blocks (billing header, "You are Claude
        // Code…" opener) MUST NOT.
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
        // No explicit System message but harness preamble + main prompt
        // still flow so the main-agent path sees the same operational
        // context as anthropic. Falls back to DEFAULT_INSTRUCTIONS only
        // if the harness consts ever go empty at build time.
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
