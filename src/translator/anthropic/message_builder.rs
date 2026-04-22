

use serde_json::Value;

use crate::harness::reminders::build_preamble_blocks_with_git;
use crate::inference::{OpenAiChatMessage, OpenAiChatRole};

use super::blocks::{AnthropicMessage, Block, Role};
use super::UserContext;

pub fn build(messages: &[OpenAiChatMessage], ctx: &UserContext<'_>) -> Vec<Value> {
    let mut normalized = normalize(messages, ctx);
    add_cache_breakpoints(&mut normalized);
    normalized.iter().map(|m| m.to_json()).collect()
}

pub fn normalize(messages: &[OpenAiChatMessage], ctx: &UserContext<'_>) -> Vec<AnthropicMessage> {
    let mut out: Vec<AnthropicMessage> = Vec::new();
    let mut pending_tool_results: Vec<Block> = Vec::new();
    let mut first_user = true;

    for msg in messages {
        match msg.role {
            OpenAiChatRole::System => {
                tracing::debug!(
                    "normalize: discarding OpenAI role=system message; harness provides system[]"
                );
            }
            OpenAiChatRole::User => {
                flush_tool_results(&mut pending_tool_results, &mut out);
                let mut blocks: Vec<Block> = Vec::new();
                if first_user {
                    let preamble =
                        build_preamble_blocks_with_git(ctx.email, ctx.current_date, ctx.git_status);
                    for p in preamble {
                        blocks.push(Block::Text {
                            text: p["text"]
                                .as_str()
                                .expect("preamble block carries text")
                                .to_string(),
                            cache_control: None,
                        });
                    }
                    first_user = false;
                }
                blocks.push(Block::Text {
                    text: msg.content.clone(),
                    cache_control: None,
                });
                out.push(AnthropicMessage {
                    role: Role::User,
                    content: blocks,
                });
            }
            OpenAiChatRole::Assistant => {
                flush_tool_results(&mut pending_tool_results, &mut out);
                let mut blocks: Vec<Block> = Vec::new();
                if !msg.content.is_empty() {
                    blocks.push(Block::Text {
                        text: msg.content.clone(),
                        cache_control: None,
                    });
                }
                for call in &msg.tool_calls {
                    let input: Value = if call.function.arguments.is_empty() {
                        Value::Object(Default::default())
                    } else {
                        serde_json::from_str(&call.function.arguments).unwrap_or_else(|e| {
                            tracing::warn!(
                                "tool_call.function.arguments is not valid JSON ({e}); emitting empty object"
                            );
                            Value::Object(Default::default())
                        })
                    };
                    blocks.push(Block::ToolUse {
                        id: call.id.clone(),
                        name: call.function.name.clone(),
                        input,
                    });
                }
                if !blocks.is_empty() {
                    out.push(AnthropicMessage {
                        role: Role::Assistant,
                        content: blocks,
                    });
                }
            }
            OpenAiChatRole::Tool => {
                let tool_use_id = msg.tool_call_id.clone().unwrap_or_else(|| {
                    tracing::warn!("role=tool message missing tool_call_id");
                    String::new()
                });
                pending_tool_results.push(Block::ToolResult {
                    tool_use_id,
                    content: msg.content.clone(),
                    cache_control: None,
                });
            }
        }
    }
    flush_tool_results(&mut pending_tool_results, &mut out);
    out
}

fn flush_tool_results(pending: &mut Vec<Block>, out: &mut Vec<AnthropicMessage>) {
    if !pending.is_empty() {
        out.push(AnthropicMessage {
            role: Role::User,
            content: std::mem::take(pending),
        });
    }
}

pub fn add_cache_breakpoints(messages: &mut [AnthropicMessage]) {
    let Some(last) = messages.last_mut() else {
        tracing::error!("add_cache_breakpoints: empty messages array");
        return;
    };
    let Some(block) = last.content.last_mut() else {
        tracing::error!("add_cache_breakpoints: last message has empty content");
        return;
    };
    block.attach_cache_control();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::{
        OpenAiChatMessage, OpenAiChatRole, OpenAiToolCall, OpenAiToolCallFunction,
    };

    fn ctx() -> UserContext<'static> {
        UserContext::capture_defaults()
    }

    fn user_msg(text: &str) -> OpenAiChatMessage {
        OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: text.to_string(),
            ..Default::default()
        }
    }

    fn assistant_tool_use(id: &str, name: &str, args_json: &str) -> OpenAiChatMessage {
        OpenAiChatMessage {
            role: OpenAiChatRole::Assistant,
            content: String::new(),
            tool_calls: vec![OpenAiToolCall {
                id: id.to_string(),
                kind: "function".to_string(),
                function: OpenAiToolCallFunction {
                    name: name.to_string(),
                    arguments: args_json.to_string(),
                },
            }],
            ..Default::default()
        }
    }

    fn tool_result(id: &str, content: &str) -> OpenAiChatMessage {
        OpenAiChatMessage {
            role: OpenAiChatRole::Tool,
            content: content.to_string(),
            tool_call_id: Some(id.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn single_user_turn_emits_preamble_plus_prompt() {
        let msgs = vec![user_msg("hi")];
        let n = normalize(&msgs, &ctx());
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].role, Role::User);
        assert_eq!(n[0].content.len(), 4);

        match &n[0].content[3] {
            Block::Text { text, .. } => assert_eq!(text, "hi"),
            _ => panic!("expected Text block"),
        }
    }

    #[test]
    fn tool_result_coalesce_into_single_user_turn() {
        let msgs = vec![
            user_msg("list files"),
            assistant_tool_use("t1", "Glob", r#"{"pattern":"*.rs"}"#),
            tool_result("t1", "a.rs\nb.rs"),
        ];
        let n = normalize(&msgs, &ctx());
        assert_eq!(n.len(), 3);
        assert_eq!(n[0].role, Role::User);
        assert_eq!(n[1].role, Role::Assistant);
        assert_eq!(n[2].role, Role::User);
        assert_eq!(n[2].content.len(), 1);
        match &n[2].content[0] {
            Block::ToolResult { tool_use_id, content, .. } => {
                assert_eq!(tool_use_id, "t1");
                assert_eq!(content, "a.rs\nb.rs");
            }
            _ => panic!("expected ToolResult"),
        }
    }

    #[test]
    fn two_consecutive_tool_results_coalesce() {
        let msgs = vec![
            user_msg("do it"),
            OpenAiChatMessage {
                role: OpenAiChatRole::Assistant,
                content: String::new(),
                tool_calls: vec![
                    OpenAiToolCall {
                        id: "t1".into(),
                        kind: "function".into(),
                        function: OpenAiToolCallFunction {
                            name: "Glob".into(),
                            arguments: "{}".into(),
                        },
                    },
                    OpenAiToolCall {
                        id: "t2".into(),
                        kind: "function".into(),
                        function: OpenAiToolCallFunction {
                            name: "Read".into(),
                            arguments: "{}".into(),
                        },
                    },
                ],
                ..Default::default()
            },
            tool_result("t1", "r1"),
            tool_result("t2", "r2"),
        ];
        let n = normalize(&msgs, &ctx());
        assert_eq!(n.len(), 3);
        assert_eq!(n[2].role, Role::User);
        assert_eq!(n[2].content.len(), 2);
    }

    #[test]
    fn second_user_turn_has_no_preamble() {
        let msgs = vec![
            user_msg("first"),
            OpenAiChatMessage {
                role: OpenAiChatRole::Assistant,
                content: "ok".to_string(),
                ..Default::default()
            },
            user_msg("follow-up"),
        ];
        let n = normalize(&msgs, &ctx());
        assert_eq!(n.len(), 3);
        assert_eq!(n[0].content.len(), 4);
        assert_eq!(n[2].content.len(), 1);
    }

    #[test]
    fn add_cache_breakpoints_marks_last_block_of_last_message() {
        let msgs = vec![user_msg("hi")];
        let built = build(&msgs, &ctx());

        let first_msg = &built[0];
        let content = first_msg["content"].as_array().unwrap();
        assert_eq!(content.len(), 4);
        assert!(content[3].get("cache_control").is_some());
        for i in 0..3 {
            assert!(content[i].get("cache_control").is_none(), "preamble[{i}] must not carry cache_control");
        }
    }

    #[test]
    fn exactly_one_cache_control_across_whole_messages_array() {
        let msgs = vec![
            user_msg("list"),
            assistant_tool_use("t1", "Glob", "{}"),
            tool_result("t1", "r"),
        ];
        let built = build(&msgs, &ctx());
        let mut count = 0;
        for m in &built {
            for block in m["content"].as_array().unwrap() {
                if block.get("cache_control").is_some() {
                    count += 1;
                }
            }
        }
        assert_eq!(count, 1, "exactly one cache_control marker must be set");
    }

    #[test]
    fn cache_control_lands_on_final_tool_result() {
        let msgs = vec![
            user_msg("list"),
            assistant_tool_use("t1", "Glob", "{}"),
            tool_result("t1", "r"),
        ];
        let built = build(&msgs, &ctx());

        let last = built.last().unwrap();
        let content = last["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "tool_result");
        assert!(content[0].get("cache_control").is_some());
    }

    #[test]
    fn system_messages_are_discarded() {
        let msgs = vec![
            OpenAiChatMessage {
                role: OpenAiChatRole::System,
                content: "ignore me".to_string(),
                ..Default::default()
            },
            user_msg("hi"),
        ];
        let n = normalize(&msgs, &ctx());
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].role, Role::User);
    }

    #[test]
    fn orphan_tool_result_becomes_user_turn_with_empty_id() {

        let msgs = vec![OpenAiChatMessage {
            role: OpenAiChatRole::Tool,
            content: "orphan".to_string(),
            tool_call_id: None,
            ..Default::default()
        }];
        let n = normalize(&msgs, &ctx());
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].role, Role::User);
    }
}
