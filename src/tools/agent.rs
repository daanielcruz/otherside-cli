//! `Agent` tool — launches subagents (parallel / sequential delegation).
//!
//! This module was renamed from `task.rs` in change 010 because upstream
//! Claude Code 2.1.113 advertises the tool as `Agent` on the wire
//! (captured 2026-04-18; see decisions-log C48). R-20 protects both
//! `Task` and `Agent` as training anchors — we pick the one upstream
//! ships today.
//!
//! MVP behavior: return a structured "subagents registry not yet wired"
//! response so the model sees its call reached a wired surface and can
//! back off gracefully. Full subagent orchestration (skills graph,
//! yielding, parallel dispatch) is a later-phase concern.

use serde_json::{json, Value};

use super::ToolError;

/// Dispatch a subagent launch request. Stub for MVP — returns
/// `{status: "unavailable", ...}` so the agent loop can forward to the
/// model without crashing.
pub fn agent(args: &Value) -> Result<Value, ToolError> {
    let description = args
        .get("description")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("description is required".into()))?;
    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("prompt is required".into()))?;
    let subagent_type = args
        .get("subagent_type")
        .and_then(Value::as_str)
        .unwrap_or("general-purpose");

    Ok(json!({
        "status": "unavailable",
        "subagent_type_requested": subagent_type,
        "description": description,
        "prompt_preview": prompt.chars().take(120).collect::<String>(),
        "reason": "subagents registry not yet wired — scheduled for the next phase. The model's request has been recorded.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_returns_unavailable_status() {
        let res = agent(&json!({
            "description": "test",
            "prompt": "do something",
        }))
        .unwrap();
        assert_eq!(res["status"], "unavailable");
        assert_eq!(res["subagent_type_requested"], "general-purpose");
    }

    #[test]
    fn agent_requires_description_and_prompt() {
        assert!(agent(&json!({})).is_err());
        assert!(agent(&json!({"description": "x"})).is_err());
        assert!(agent(&json!({"prompt": "y"})).is_err());
    }

    #[test]
    fn agent_honors_explicit_subagent_type() {
        let res = agent(&json!({
            "description": "test",
            "prompt": "p",
            "subagent_type": "researcher",
        }))
        .unwrap();
        assert_eq!(res["subagent_type_requested"], "researcher");
    }
}
