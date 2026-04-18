//! Task tool — dispatches sub-agents. The full agent-loop orchestration
//! + skill/agent registry lands with Phase 3. This build returns a
//! structured "no subagents configured" response so the model can see
//! its call reached a wired surface and back off gracefully.

use serde_json::{json, Value};

use super::ToolError;

pub fn task(args: &Value) -> Result<Value, ToolError> {
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
    fn task_returns_unavailable_status() {
        let res = task(&json!({
            "description": "test",
            "prompt": "do something",
        }))
        .unwrap();
        assert_eq!(res["status"], "unavailable");
        assert_eq!(res["subagent_type_requested"], "general-purpose");
    }

    #[test]
    fn task_requires_description_and_prompt() {
        assert!(task(&json!({})).is_err());
        assert!(task(&json!({"description": "x"})).is_err());
        assert!(task(&json!({"prompt": "y"})).is_err());
    }
}
