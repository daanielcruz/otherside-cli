//! Hook event vocabulary + per-event context → env-var mapping.
//!
//! Env-var names are byte-verbatim upstream. User scripts rely on
//! them; any drift breaks the hook integration contract.

use serde::{Deserialize, Serialize};

/// All hook events. Matches the six discriminants on
/// `HooksConfig` (`pre_tool_use`, `post_tool_use`, etc.).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Event {
    PreToolUse,
    PostToolUse,
    UserPromptSubmit,
    Stop,
    SubagentStop,
    PreCompact,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreToolUseCtx {
    pub tool_name: String,
    pub tool_input: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostToolUseCtx {
    pub tool_name: String,
    pub tool_input: String,
    pub tool_exit: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserPromptSubmitCtx {
    pub prompt_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopCtx {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentStopCtx {
    pub session_id: String,
    pub subagent_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreCompactCtx {
    pub session_id: String,
    pub transcript_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventCtx {
    PreToolUse(PreToolUseCtx),
    PostToolUse(PostToolUseCtx),
    UserPromptSubmit(UserPromptSubmitCtx),
    Stop(StopCtx),
    SubagentStop(SubagentStopCtx),
    PreCompact(PreCompactCtx),
}

/// Compile the context into the env-var pairs passed to the hook
/// subprocess. Names and casing match upstream.
pub fn env_for(ctx: &EventCtx) -> Vec<(String, String)> {
    match ctx {
        EventCtx::PreToolUse(c) => vec![
            ("TOOL_NAME".into(), c.tool_name.clone()),
            ("TOOL_INPUT".into(), c.tool_input.clone()),
        ],
        EventCtx::PostToolUse(c) => vec![
            ("TOOL_NAME".into(), c.tool_name.clone()),
            ("TOOL_INPUT".into(), c.tool_input.clone()),
            ("TOOL_EXIT".into(), c.tool_exit.to_string()),
        ],
        EventCtx::UserPromptSubmit(c) => {
            vec![("PROMPT_TEXT".into(), c.prompt_text.clone())]
        }
        EventCtx::Stop(c) => vec![("SESSION_ID".into(), c.session_id.clone())],
        EventCtx::SubagentStop(c) => vec![
            ("SESSION_ID".into(), c.session_id.clone()),
            ("SUBAGENT_ID".into(), c.subagent_id.clone()),
        ],
        EventCtx::PreCompact(c) => vec![
            ("SESSION_ID".into(), c.session_id.clone()),
            ("TRANSCRIPT_PATH".into(), c.transcript_path.clone()),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_tool_use_env_matches_contract() {
        let ctx = EventCtx::PreToolUse(PreToolUseCtx {
            tool_name: "Edit".into(),
            tool_input: "{\"path\":\"x\"}".into(),
        });
        let env = env_for(&ctx);
        assert_eq!(env[0], ("TOOL_NAME".to_string(), "Edit".to_string()));
        assert_eq!(env[1].0, "TOOL_INPUT");
    }

    #[test]
    fn post_tool_use_env_includes_exit() {
        let ctx = EventCtx::PostToolUse(PostToolUseCtx {
            tool_name: "Bash".into(),
            tool_input: "ls".into(),
            tool_exit: 0,
        });
        let env = env_for(&ctx);
        assert!(env.iter().any(|(k, v)| k == "TOOL_EXIT" && v == "0"));
    }

    #[test]
    fn user_prompt_submit_env() {
        let ctx = EventCtx::UserPromptSubmit(UserPromptSubmitCtx {
            prompt_text: "hello".into(),
        });
        let env = env_for(&ctx);
        assert_eq!(env[0], ("PROMPT_TEXT".to_string(), "hello".to_string()));
    }

    #[test]
    fn stop_env_carries_session_id() {
        let ctx = EventCtx::Stop(StopCtx {
            session_id: "abc-123".into(),
        });
        let env = env_for(&ctx);
        assert_eq!(env[0].0, "SESSION_ID");
        assert_eq!(env[0].1, "abc-123");
    }
}
