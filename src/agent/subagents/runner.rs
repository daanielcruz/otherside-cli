

use std::sync::Arc;

use serde_json::{json, Value};

use crate::agent::{AgentLoop, ToolDispatcher, MAX_AUTO_TURNS};
use crate::error::{Error, Result as AgentResult};
use crate::inference::{OpenAiChatMessage, OpenAiChatRole};
use crate::provider::Provider;

use super::frontmatter::ToolsField;
use super::{registry, AgentInvocation, RunnerError, SubagentRunner};

pub struct GatedToolDispatcher {
    pub tools: ToolsField,
}

impl GatedToolDispatcher {
    pub fn new(tools: ToolsField) -> Self {
        Self { tools }
    }

    fn allows(&self, name: &str) -> bool {
        match &self.tools {
            ToolsField::Wildcard => true,
            ToolsField::List(list) => list.iter().any(|t| t == name),
        }
    }
}

impl ToolDispatcher for GatedToolDispatcher {
    fn dispatch(&self, name: &str, args: &Value) -> AgentResult<Value> {
        if !self.allows(name) {
            return Err(Error::Other(format!(
                "subagent cannot call tool `{name}` (not in allowlist)"
            )));
        }
        crate::tools::dispatch(name, args)
            .map_err(|e| Error::Other(format!("tool `{name}`: {e}")))
    }
}

pub const SUBAGENT_MAX_TURNS: u32 = MAX_AUTO_TURNS;

pub struct InnerLoopRunner {
    provider: Arc<dyn Provider>,
    default_model: String,
}

impl InnerLoopRunner {
    pub fn new(provider: Arc<dyn Provider>, default_model: String) -> Arc<dyn SubagentRunner> {
        Arc::new(Self {
            provider,
            default_model,
        })
    }

    fn run_inner(
        &self,
        definition: &registry::AgentDefinition,
        prompt: &str,
        depth: u32,
        invocation: &AgentInvocation,
    ) -> Result<Value, RunnerError> {
        let started = std::time::Instant::now();
        let model = crate::models::agents::resolve_agent_model(
            invocation.model.as_deref(),
            definition.model.as_deref(),
            &self.default_model,
        );

        let mut history: Vec<OpenAiChatMessage> = Vec::with_capacity(2);
        match self.provider.id() {
            "codex" => {
                history.push(OpenAiChatMessage {
                    role: OpenAiChatRole::System,
                    content: definition.system_prompt.clone(),
                    name: None,
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
            }
            other => {
                tracing::debug!(
                    provider = other,
                    "subagent system_prompt seed skipped; translator discards role=system"
                );
            }
        }
        history.push(OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: prompt.to_string(),
            name: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
        });

        let dispatcher = GatedToolDispatcher::new(definition.tools.clone());
        let loop_ = AgentLoop {
            model: model.clone(),
            thinking: None,
            max_turns: SUBAGENT_MAX_TURNS,
            dispatcher,
        };

        let provider = self.provider.clone();

        let loop_result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async move {
                loop_
                    .run(history, |req, thinking_cfg| {
                        let provider = provider.clone();
                        async move { provider.stream(req, thinking_cfg).await }
                    })
                    .await
            })
        })
        .map_err(|e| RunnerError::Internal(format!("inner agent loop: {e}")))?;

        let duration_ms = started.elapsed().as_millis() as u64;
        let assistant_text = loop_result
            .history
            .iter()
            .rev()
            .find(|m| m.role == OpenAiChatRole::Assistant)
            .map(|m| m.content.clone())
            .unwrap_or_default();
        let total_tool_uses: u64 = loop_result
            .history
            .iter()
            .filter(|m| m.role == OpenAiChatRole::Assistant)
            .map(|m| m.tool_calls.len() as u64)
            .sum();
        let status = if loop_result.hit_turn_limit {
            "budget_exceeded"
        } else {
            "completed"
        };
        Ok(json!({
            "status": status,
            "subagent_type": definition.name,
            "agentType": definition.name,
            "content": [{"type": "text", "text": assistant_text}],
            "totalToolUseCount": total_tool_uses,
            "totalTokens": 0,
            "totalDurationMs": duration_ms,
            "depth": depth,
            "model": model,
            "turnsTaken": loop_result.turns,
            "invocation": {
                "model_requested": invocation.model,
                "run_in_background_requested": invocation.run_in_background,
                "isolation_requested": invocation.isolation,
            },
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
            },
        }))
    }
}

impl SubagentRunner for InnerLoopRunner {
    fn run(
        &self,
        definition: &registry::AgentDefinition,
        prompt: &str,
        depth: u32,
        invocation: &AgentInvocation,
    ) -> Result<Value, RunnerError> {
        self.run_inner(definition, prompt, depth, invocation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::subagents::frontmatter::ToolsField;

    #[test]
    fn gated_dispatcher_wildcard_allows_any_tool() {
        let g = GatedToolDispatcher::new(ToolsField::Wildcard);
        for name in ["Read", "Bash", "Edit", "Agent"] {
            assert!(g.allows(name), "wildcard must allow `{name}`");
        }
    }

    #[test]
    fn gated_dispatcher_list_restricts() {
        let g = GatedToolDispatcher::new(ToolsField::List(vec![
            "Read".into(),
            "Glob".into(),
        ]));
        assert!(g.allows("Read"));
        assert!(g.allows("Glob"));
        assert!(!g.allows("Bash"));
        assert!(!g.allows("Edit"));
    }

    #[test]
    fn gated_dispatcher_denies_out_of_allowlist_with_error() {
        let g = GatedToolDispatcher::new(ToolsField::List(vec!["Read".into()]));
        let err = g
            .dispatch("Bash", &serde_json::json!({"command": "ls"}))
            .unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("Bash"));
        assert!(msg.contains("allowlist"));
    }
}
