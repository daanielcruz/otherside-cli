

use serde_json::{json, Value};

use otherside::inference::{
    OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole, OpenAiToolCall, OpenAiToolCallFunction,
};
use otherside::translator::anthropic::blocks::{
    AnthropicMessage, Block, Role,
};
use otherside::translator::anthropic::{
    build_request_body, message_builder, UserContext,
};

fn capture(turn: u8) -> Value {
    let path = format!(
        "../fingerprint_corpus/tools-glob-single/turn{turn}/request.body.json"
    );
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("capture {path} readable: {e}"));
    serde_json::from_str(&raw).expect("capture parses as JSON")
}

const TURN1_PROMPT: &str = "list all .rs files directly in src/ and tell me in one sentence what main.rs does";

fn build_via_entrypoint(req: &OpenAiChatRequest, ctx: &UserContext<'_>) -> Value {
    let bytes = build_request_body(req, ctx).expect("build_request_body succeeds");
    serde_json::from_slice(&bytes).expect("built body parses as JSON")
}

#[test]
#[ignore = "V2 drift: verification bullet in system-prompt.md + skills.txt / deferred-tools.txt user-authored cuts make byte-exact match impossible until a V2-reference capture is taken. Structural asserts live in harness_artifacts.rs."]
fn turn1_byte_match_against_capture() {
    let req = OpenAiChatRequest {
        model: "claude-opus-4-7".to_string(),
        messages: vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: TURN1_PROMPT.to_string(),
            ..Default::default()
        }],
        stream: Some(true),
        ..Default::default()
    };
    let ctx = UserContext::capture_defaults();
    let built = build_via_entrypoint(&req, &ctx);
    let expected = capture(1);
    assert_eq!(built, expected, "turn1 body diverges from capture");
}

#[test]
fn turn1_top_level_keys_match_capture_order() {
    let req = OpenAiChatRequest {
        model: "claude-opus-4-7".to_string(),
        messages: vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: TURN1_PROMPT.to_string(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let ctx = UserContext::capture_defaults();
    let bytes = build_request_body(&req, &ctx).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    let expected_order = [
        "model",
        "messages",
        "system",
        "tools",
        "metadata",
        "max_tokens",
        "thinking",
        "context_management",
        "output_config",
        "stream",
    ];
    let mut last_idx = 0;
    for key in expected_order {
        let needle = format!("\"{key}\"");
        let idx = text.find(&needle).unwrap_or_else(|| panic!("missing key {key}"));
        assert!(idx >= last_idx, "key `{key}` out of order");
        last_idx = idx;
    }
}

fn scrub_ids(body: &mut Value, id_map: &[(&str, &str)]) {
    fn walk(v: &mut Value, id_map: &[(&str, &str)]) {
        match v {
            Value::Object(m) => {
                for (k, v) in m.iter_mut() {
                    if k == "id" || k == "tool_use_id" {
                        if let Some(s) = v.as_str() {
                            if let Some((_, placeholder)) =
                                id_map.iter().find(|(orig, _)| orig == &s)
                            {
                                *v = Value::String((*placeholder).to_string());
                            }
                        }
                    }
                    walk(v, id_map);
                }
            }
            Value::Array(a) => {
                for item in a.iter_mut() {
                    walk(item, id_map);
                }
            }
            _ => {}
        }
    }
    walk(body, id_map);
}

const CAPTURE_THINKING_SIGNATURE: &str = "EpUCClkIDBgCKkBoDodzDJYTc9zImpelmvf4rPUbZJgL4EqwWRBgu3cNu22L03frQDJ+Em4kDNmChx+45L6ZRg6DtFZzLIoSSwP7Mg9jbGF1ZGUtb3B1cy00LTc4ABIMrAqVujVqPgZF1WtJGgzDzYuymS9/FeV4q9AiMPsPnyxMla1HapxDBHzcUP0f/+SUO8uT2pPSgzBDhpL23BxBbVufsprDR71IdCAttCpqBh+QN0OT6TuVA7j1uVeoHl03WpQo+W7ENMaHWQq0cfJATlQAgGGcnxv6vO0PdtnfwD1v6kIg5RZ1C1u+5xTk9QyUPp6koltWMG0EfP58ushYYEhlNok0VxhcUUrYe4UYDtMudDYVNluRTxgB";

#[test]
#[ignore = "V2 drift — see turn1 note"]
fn turn2_messages_fragment_matches_capture() {

    let preamble =
        otherside::harness::reminders::build_preamble_blocks("edaanxx@gmail.com", "2026-04-18");
    let user1 = AnthropicMessage {
        role: Role::User,
        content: vec![
            Block::Text {
                text: preamble[0]["text"].as_str().unwrap().to_string(),
                cache_control: None,
            },
            Block::Text {
                text: preamble[1]["text"].as_str().unwrap().to_string(),
                cache_control: None,
            },
            Block::Text {
                text: preamble[2]["text"].as_str().unwrap().to_string(),
                cache_control: None,
            },
            Block::Text {
                text: TURN1_PROMPT.to_string(),
                cache_control: None,
            },
        ],    };
    let assistant = AnthropicMessage {
        role: Role::Assistant,
        content: vec![
            Block::Thinking {
                thinking: String::new(),
                signature: CAPTURE_THINKING_SIGNATURE.to_string(),
            },
            Block::ToolUse {
                id: "XXX_TOOLUSE_ID_1_XXX".to_string(),
                name: "Glob".to_string(),
                input: json!({ "pattern": "src/*.rs" }),
            },
        ],    };
    let user2 = AnthropicMessage {
        role: Role::User,
        content: vec![Block::ToolResult {
            tool_use_id: "XXX_TOOLUSE_ID_1_XXX".to_string(),
            content: "src/main.rs\nsrc/error.rs\nsrc/lib.rs".to_string(),
            cache_control: None,
        }],    };
    let mut msgs = vec![user1, assistant, user2];
    message_builder::add_cache_breakpoints(&mut msgs);

    let built: Vec<Value> = msgs.iter().map(|m| m.to_json()).collect();
    let expected = capture(2)["messages"].as_array().unwrap().clone();
    assert_eq!(built, expected, "turn2 messages[] diverges from capture");
}

#[test]
#[ignore = "V2 drift — see turn1 note"]
fn turn3_messages_fragment_matches_capture() {
    let preamble =
        otherside::harness::reminders::build_preamble_blocks("edaanxx@gmail.com", "2026-04-18");
    let user1 = AnthropicMessage {
        role: Role::User,
        content: vec![
            Block::Text {
                text: preamble[0]["text"].as_str().unwrap().to_string(),
                cache_control: None,
            },
            Block::Text {
                text: preamble[1]["text"].as_str().unwrap().to_string(),
                cache_control: None,
            },
            Block::Text {
                text: preamble[2]["text"].as_str().unwrap().to_string(),
                cache_control: None,
            },
            Block::Text {
                text: TURN1_PROMPT.to_string(),
                cache_control: None,
            },
        ],    };
    let assistant1 = AnthropicMessage {
        role: Role::Assistant,
        content: vec![
            Block::Thinking {
                thinking: String::new(),
                signature: CAPTURE_THINKING_SIGNATURE.to_string(),
            },
            Block::ToolUse {
                id: "XXX_TOOLUSE_ID_1_XXX".to_string(),
                name: "Glob".to_string(),
                input: json!({ "pattern": "src/*.rs" }),
            },
        ],    };
    let user2 = AnthropicMessage {
        role: Role::User,
        content: vec![Block::ToolResult {
            tool_use_id: "XXX_TOOLUSE_ID_1_XXX".to_string(),
            content: "src/main.rs\nsrc/error.rs\nsrc/lib.rs".to_string(),
            cache_control: None,
        }],    };
    let assistant2 = AnthropicMessage {
        role: Role::Assistant,
        content: vec![Block::ToolUse {
            id: "XXX_TOOLUSE_ID_2_XXX".to_string(),
            name: "Read".to_string(),
            input: json!({ "file_path": "/workspace/src/main.rs" }),
        }],    };
    let user3 = AnthropicMessage {
        role: Role::User,
        content: vec![Block::ToolResult {
            tool_use_id: "XXX_TOOLUSE_ID_2_XXX".to_string(),
            content: "1\tfn main() {\n2\t    println!(\"otherside capture target\");\n3\t}\n4\t"
                .to_string(),
            cache_control: None,
        }],    };
    let mut msgs = vec![user1, assistant1, user2, assistant2, user3];
    message_builder::add_cache_breakpoints(&mut msgs);

    let built: Vec<Value> = msgs.iter().map(|m| m.to_json()).collect();
    let expected = capture(3)["messages"].as_array().unwrap().clone();
    assert_eq!(built, expected, "turn3 messages[] diverges from capture");
}

#[test]
fn openai_history_with_tool_round_trip_produces_three_messages() {
    let req = OpenAiChatRequest {
        model: "claude-opus-4-7".to_string(),
        messages: vec![
            OpenAiChatMessage {
                role: OpenAiChatRole::User,
                content: TURN1_PROMPT.to_string(),
                ..Default::default()
            },
            OpenAiChatMessage {
                role: OpenAiChatRole::Assistant,
                content: String::new(),
                tool_calls: vec![OpenAiToolCall {
                    id: "toolu_actual_01".to_string(),
                    kind: "function".to_string(),
                    function: OpenAiToolCallFunction {
                        name: "Glob".to_string(),
                        arguments: r#"{"pattern":"src/*.rs"}"#.to_string(),
                    },
                }],
                ..Default::default()
            },
            OpenAiChatMessage {
                role: OpenAiChatRole::Tool,
                content: "src/main.rs\nsrc/error.rs\nsrc/lib.rs".to_string(),
                tool_call_id: Some("toolu_actual_01".to_string()),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let ctx = UserContext::capture_defaults();
    let bytes = build_request_body(&req, &ctx).unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[2]["role"], "user");
    assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
    assert_eq!(msgs[1]["content"][0]["name"], "Glob");
    assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
    assert!(msgs[2]["content"][0].get("cache_control").is_some());
}

#[test]
#[ignore = "V2 drift — see turn1 note"]
fn openai_round_trip_turn2_matches_capture_sans_thinking_block() {
    let req = OpenAiChatRequest {
        model: "claude-opus-4-7".to_string(),
        messages: vec![
            OpenAiChatMessage {
                role: OpenAiChatRole::User,
                content: TURN1_PROMPT.to_string(),
                ..Default::default()
            },
            OpenAiChatMessage {
                role: OpenAiChatRole::Assistant,
                content: String::new(),
                tool_calls: vec![OpenAiToolCall {
                    id: "toolu_actual_01".to_string(),
                    kind: "function".to_string(),
                    function: OpenAiToolCallFunction {
                        name: "Glob".to_string(),
                        arguments: r#"{"pattern":"src/*.rs"}"#.to_string(),
                    },
                }],
                ..Default::default()
            },
            OpenAiChatMessage {
                role: OpenAiChatRole::Tool,
                content: "src/main.rs\nsrc/error.rs\nsrc/lib.rs".to_string(),
                tool_call_id: Some("toolu_actual_01".to_string()),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let ctx = UserContext::capture_defaults();
    let bytes = build_request_body(&req, &ctx).unwrap();
    let mut body: Value = serde_json::from_slice(&bytes).unwrap();

    scrub_ids(&mut body, &[("toolu_actual_01", "XXX_TOOLUSE_ID_1_XXX")]);

    let mut expected = capture(2);
    let assistant_content = expected["messages"][1]["content"]
        .as_array_mut()
        .unwrap();
    assistant_content.retain(|b| b["type"] != "thinking");

    assert_eq!(body["messages"], expected["messages"]);
}
