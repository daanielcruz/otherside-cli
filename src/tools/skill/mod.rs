

use serde_json::{json, Value};

use crate::tools::ToolError;

const DEFERRED_TOOL_NAMES: &[&str] = &[
    "AskUserQuestion",
    "CronCreate",
    "CronDelete",
    "CronList",
    "EnterPlanMode",
    "EnterWorktree",
    "ExitPlanMode",
    "ExitWorktree",
    "NotebookEdit",
    "ScheduleWakeup",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskOutput",
    "TaskStop",
    "TaskUpdate",
    "WebFetch",
    "WebSearch",
];

fn lookup_bundled_skill(name: &str) -> Option<&'static str> {
    crate::tui::slash::skill::lookup_body(name)
}

fn bundled_skill_names() -> Vec<&'static str> {
    crate::tui::slash::skill::bundled_names()
}

pub fn skill(args: &Value) -> Result<Value, ToolError> {
    let name = args
        .get("skill")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("skill name is required".into()))?;
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return Err(ToolError::InvalidArgs(format!(
            "invalid skill name: {name}"
        )));
    }

    if let Some(content) = lookup_bundled_skill(name) {
        let forwarded_args = args
            .get("args")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Ok(json!({
            "skill": name,
            "args": forwarded_args,
            "content": content,
        }));
    }

    let mut hints: Vec<String> = Vec::new();
    let available = bundled_skill_names();
    if !available.is_empty() {
        hints.push(format!("available skills: {}", available.join(", ")));
    }
    if DEFERRED_TOOL_NAMES
        .iter()
        .any(|n| n.eq_ignore_ascii_case(name))
    {
        hints.push(format!(
            "`{name}` is a deferred TOOL, not a skill — load its schema via ToolSearch(query: \"select:{name}\") and then call {name} directly"
        ));
    }
    let joined = if hints.is_empty() {
        "no bundled skill by that name".to_string()
    } else {
        hints.join("; ")
    };
    Err(ToolError::InvalidArgs(format!(
        "unknown skill: {name} ({joined})"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_missing_name_errors() {
        let err = skill(&json!({})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn skill_unknown_errors_cleanly() {
        let err = skill(&json!({"skill": "definitely-not-a-real-skill-xyz"})).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("unknown skill"));
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn skill_rejects_path_traversal() {
        assert!(skill(&json!({"skill": "../etc/passwd"})).is_err());
        assert!(skill(&json!({"skill": "foo/bar"})).is_err());
    }

    #[test]
    fn skill_empty_name_errors() {
        assert!(skill(&json!({"skill": ""})).is_err());
    }
}
