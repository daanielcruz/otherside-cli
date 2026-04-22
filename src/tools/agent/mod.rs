

use serde_json::{json, Value};

use crate::agent::subagents::{registry, AgentInvocation, DepthGuard, RunnerError, SubagentRunner};

use crate::tools::ToolError;

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

    let invocation = AgentInvocation {
        model: args
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        run_in_background: args
            .get("run_in_background")
            .and_then(Value::as_bool),
        isolation: args
            .get("isolation")
            .and_then(Value::as_str)
            .map(str::to_string),
    };

    let Some(definition) = registry::resolve(subagent_type) else {
        let available: Vec<&str> = registry::all().iter().map(|d| d.name.as_str()).collect();
        return Err(ToolError::InvalidArgs(format!(
            "unknown subagent_type `{subagent_type}` — registered types: {}",
            available.join(", ")
        )));
    };

    let Some(_guard) = DepthGuard::try_push() else {
        return Err(ToolError::InvalidArgs(format!(
            "subagent recursion depth exceeded (max {})",
            crate::agent::subagents::MAX_DEPTH
        )));
    };
    let depth_at_entry = crate::agent::subagents::depth::current() - 1;

    let Some(runner) = crate::agent::subagents::current_runner() else {
        return Ok(json!({
            "status": "unavailable",
            "subagent_type_requested": subagent_type,
            "description": description,
            "prompt_preview": prompt.chars().take(120).collect::<String>(),
            "model_requested": invocation.model,
            "run_in_background_requested": invocation.run_in_background,
            "isolation_requested": invocation.isolation,
            "reason": "subagents runner not installed — the binary did not wire a runner before dispatch",
        }));
    };

    let wants_background = matches!(invocation.run_in_background, Some(true));
    if wants_background && !crate::tasks::is_disabled() {
        if let Some(store) = crate::tasks::store::current_global() {
            let display = if description.is_empty() {
                subagent_type.to_string()
            } else {
                description.to_string()
            };

            let tool_use_id = crate::tools::current_tool_call_id();
            let outcome = crate::tasks::spawn_background_agent(
                runner,
                definition.clone(),
                prompt.to_string(),
                depth_at_entry,
                invocation.clone(),
                store,
                display.clone(),
                tool_use_id.clone(),
            );

            // Surface the upstream-shape agentId (`a<16hex>`) to the model —
            // NOT the internal TaskStore key and NOT the Anthropic
            // tool_use_id. Matches `utils/uuid.ts:24 createAgentId`.
            let upstream_text = format!(
                "Async agent launched successfully.\nagentId: {agent_id} (internal ID - do not mention to user. Use SendMessage with to: '{agent_id}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.",
                agent_id = outcome.agent_id,
            );
            return Ok(json!({
                "status": "backgrounded",
                "task_id": outcome.task_id.as_str(),
                "tool_use_id": tool_use_id,
                "agent_id": outcome.agent_id,
                "subagent_type": subagent_type,
                "description": description,
                "model_requested": invocation.model,
                "run_in_background_requested": invocation.run_in_background,
                "isolation_requested": invocation.isolation,
                "content": [{"type": "text", "text": upstream_text}],
            }));
        }
    }

    dispatch_with_runner(runner.as_ref(), definition, prompt, depth_at_entry, &invocation)
}

fn dispatch_with_runner(
    runner: &dyn SubagentRunner,
    definition: &registry::AgentDefinition,
    prompt: &str,
    depth_at_entry: u32,
    invocation: &AgentInvocation,
) -> Result<Value, ToolError> {
    match runner.run(definition, prompt, depth_at_entry, invocation) {
        Ok(v) => Ok(v),
        Err(RunnerError::NotInstalled) => Ok(json!({
            "status": "unavailable",
            "reason": "subagents runner not installed",
        })),
        Err(RunnerError::UnknownType(name)) => Err(ToolError::InvalidArgs(format!(
            "runner reports unknown subagent_type `{name}` (registry/runner out of sync)"
        ))),
        Err(RunnerError::DepthExceeded(n)) => Err(ToolError::InvalidArgs(format!(
            "subagent recursion depth exceeded (max {n})"
        ))),
        Err(RunnerError::Internal(msg)) => Err(ToolError::InvalidArgs(format!(
            "subagent runner error: {msg}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::subagents::{install_runner, InlineFakeRunner};
    use std::sync::Arc;

    fn once_install_fake() -> Arc<InlineFakeRunner> {
        let fake = Arc::new(InlineFakeRunner::new());

        let _ = install_runner(fake.clone() as Arc<dyn SubagentRunner>);

        fake
    }

    #[test]
    fn requires_description_and_prompt() {
        assert!(agent(&json!({})).is_err());
        assert!(agent(&json!({"description": "x"})).is_err());
        assert!(agent(&json!({"prompt": "y"})).is_err());
    }

    #[test]
    fn rejects_unknown_subagent_type() {
        let err = agent(&json!({
            "description": "t",
            "prompt": "p",
            "subagent_type": "not-a-real-type",
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(m) => {
                assert!(m.contains("unknown subagent_type"));
                assert!(m.contains("not-a-real-type"));
                assert!(m.contains("general-purpose"));
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn default_subagent_type_is_general_purpose() {

        let fake = once_install_fake();
        fake.set_content("ok-default");
        let res = agent(&json!({
            "description": "test",
            "prompt": "do it",
        }));

        match res {
            Ok(v) => {

                if v["status"] == "completed" {
                    assert_eq!(v["subagent_type"], "general-purpose");
                } else {
                    assert_eq!(v["status"], "unavailable");
                }
            }
            Err(e) => panic!("unexpected error: {e}"),
        }
    }
}
