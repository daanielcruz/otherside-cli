//! Real subagent runner — spawns a fresh inner `AgentLoop` against the
//! subagent's system prompt + tool allowlist.
//!
//! Replaces 005's `ProductiveStubRunner` which returned a marker-tagged
//! no-op. Flow:
//!
//! 1. Seed history with the subagent's `system_prompt` + the caller's
//!    `prompt` (as the initial user turn).
//! 2. Resolve the effective model: `AgentInvocation.model` wins over
//!    `AgentDefinition.model`, falling back to the runner's default.
//! 3. Build a [`GatedToolDispatcher`] that enforces
//!    `AgentDefinition.tools` on every nested tool call.
//! 4. Bridge the sync [`SubagentRunner::run`] to the async
//!    `AgentLoop::run` via `tokio::task::block_in_place` +
//!    `Handle::current().block_on` — R-107 single authorized pattern.
//! 5. Shape the result into the upstream `agentToolResultSchema`
//!    (`tui::tool_render::agent_preview` reads it verbatim).
//!
//! Zone: identity (R-103). Neutral type name + no upstream product
//! strings in copy.
//!
//! # Thread-safety
//!
//! Runner is `Send + Sync`. The stored provider is `Arc<dyn Provider>`.
//! The inner loop runs on the current tokio runtime via block-on; no
//! fresh runtime is spawned.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::agent::{AgentLoop, ToolDispatcher, MAX_AUTO_TURNS};
use crate::error::{Error, Result as AgentResult};
use crate::inference::{OpenAiChatMessage, OpenAiChatRole};
use crate::provider::Provider;

use super::frontmatter::ToolsField;
use super::{registry, AgentInvocation, RunnerError, SubagentRunner};

/// Tool dispatcher that gates every call against an allowlist before
/// delegating to the normal [`crate::tools::dispatch`]. Denied calls
/// return `ToolError::PermissionDenied` the inner loop serializes
/// into a `tool_result` block, so the nested model sees the refusal
/// and can adapt instead of silently dropping a capability.
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

/// Default tool-call budget for a single subagent dispatch. Matches
/// the outer `MAX_AUTO_TURNS` so a subagent has the same runway as
/// the top-level agent — callers hitting the cap see a
/// `budget_exceeded` status rather than a silent truncation.
pub const SUBAGENT_MAX_TURNS: u32 = MAX_AUTO_TURNS;

/// Resolve upstream-convention short aliases (`opus`, `sonnet`,
/// `haiku`, and their `[1m]` variants) to concrete model ids the
/// Anthropic `/v1/messages` API accepts. Anything else passes through
/// verbatim so custom or provider-specific ids still work.
///
/// Carries the `[1m]` suffix across the alias boundary per upstream
/// `utils/model/model.ts::parseUserSpecifiedModel`. For `opus` we
/// default to the 1M variant because the target deployment is a
/// Max subscriber with `isOpus1mMergeEnabled` on — the non-1M opus
/// is unreachable from an alias string. Explicit raw ids
/// (`claude-opus-4-7` without `[1m]`) still pass through unchanged.
///
/// TODO(multi-provider unfreeze): mapping lives here for the
/// claude-code provider only. When codex / gemini-cli unfreeze, the
/// resolver becomes provider-scoped.
fn resolve_model_alias(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let (base, has_1m) = if let Some(stripped) = lower.strip_suffix("[1m]") {
        (stripped.trim().to_string(), true)
    } else {
        (lower.clone(), false)
    };

    let resolved = match base.as_str() {
        "opus" => Some(("claude-opus-4-7", true)),
        "sonnet" => Some(("claude-sonnet-4-6", has_1m)),
        "haiku" => Some(("claude-haiku-4-5", has_1m)),
        _ => None,
    };

    match resolved {
        Some((id, carry_1m)) if carry_1m => format!("{id}[1m]"),
        Some((id, _)) => id.to_string(),
        None => raw.to_string(),
    }
}

#[cfg(test)]
mod alias_tests {
    use super::resolve_model_alias;

    #[test]
    fn bare_opus_defaults_to_1m() {
        assert_eq!(resolve_model_alias("opus"), "claude-opus-4-7[1m]");
    }

    #[test]
    fn explicit_opus_1m_passes_suffix() {
        assert_eq!(resolve_model_alias("opus[1m]"), "claude-opus-4-7[1m]");
    }

    #[test]
    fn sonnet_bare_has_no_1m() {
        assert_eq!(resolve_model_alias("sonnet"), "claude-sonnet-4-6");
    }

    #[test]
    fn sonnet_1m_carries_suffix() {
        assert_eq!(resolve_model_alias("sonnet[1m]"), "claude-sonnet-4-6[1m]");
    }

    #[test]
    fn haiku_bare_has_no_1m() {
        assert_eq!(resolve_model_alias("haiku"), "claude-haiku-4-5");
    }

    #[test]
    fn raw_id_passes_through_unchanged() {
        assert_eq!(
            resolve_model_alias("claude-opus-4-7"),
            "claude-opus-4-7"
        );
        assert_eq!(
            resolve_model_alias("claude-opus-4-7[1m]"),
            "claude-opus-4-7[1m]"
        );
    }

    #[test]
    fn unknown_alias_passes_through() {
        assert_eq!(resolve_model_alias("gpt-5.4"), "gpt-5.4");
    }
}

/// Real subagent runner. Holds the provider + the fallback model id.
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
        let raw_model = invocation
            .model
            .clone()
            .or_else(|| definition.model.clone())
            .unwrap_or_else(|| self.default_model.clone());
        let model = resolve_model_alias(&raw_model);

        let history: Vec<OpenAiChatMessage> = vec![
            OpenAiChatMessage {
                role: OpenAiChatRole::System,
                content: definition.system_prompt.clone(),
                name: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            OpenAiChatMessage {
                role: OpenAiChatRole::User,
                content: prompt.to_string(),
                name: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
        ];

        let dispatcher = GatedToolDispatcher::new(definition.tools.clone());
        let loop_ = AgentLoop {
            model: model.clone(),
            thinking: None,
            max_turns: SUBAGENT_MAX_TURNS,
            dispatcher,
        };

        let provider = self.provider.clone();
        // R-107: sync→async bridge. `block_in_place` + `block_on` is
        // the single authorized way to pivot from a sync trait method
        // into an async inner call without spawning a new runtime.
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
    use crate::subagents::frontmatter::ToolsField;

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
