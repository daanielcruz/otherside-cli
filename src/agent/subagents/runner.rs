

use std::sync::Arc;

use serde_json::{json, Value};

use crate::agent::{AgentLoop, ControlFlow, GatedDispatcher, LoopObserver, MAX_AUTO_TURNS};
use crate::error::Error;
use crate::inference::{OpenAiChatMessage, OpenAiChatRole};

use super::{registry, AgentInvocation, NestedEmitter, RunnerError, SubagentRunner};

struct NestedObserver {
    emitter: Arc<dyn NestedEmitter>,
}

impl LoopObserver for NestedObserver {
    fn on_tool_start<'a>(
        &'a self,
        _id: &'a str,
        name: &'a str,
        args: &'a Value,
    ) -> impl std::future::Future<Output = ControlFlow> + Send + 'a {
        let name = name.to_string();
        let args = args.clone();
        async move {
            self.emitter.on_tool_start(&name, &args);
            ControlFlow::Continue
        }
    }

    fn on_tool_finish<'a>(
        &'a self,
        _id: &'a str,
        _name: &'a str,
        result: std::result::Result<&'a Value, &'a str>,
        _elapsed_ms: u64,
    ) -> impl std::future::Future<Output = ControlFlow> + Send + 'a {
        let success = result.is_ok();
        async move {
            self.emitter.on_tool_finish(success);
            ControlFlow::Continue
        }
    }

    fn on_usage(
        &self,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> impl std::future::Future<Output = ControlFlow> + Send + '_ {
        async move {
            self.emitter.on_usage(input_tokens, output_tokens);
            ControlFlow::Continue
        }
    }

    fn on_stream_error<'a>(&'a self, _err: &'a Error) -> impl std::future::Future<Output = ()> + Send + 'a {
        async move {}
    }
}

pub const SUBAGENT_MAX_TURNS: u32 = MAX_AUTO_TURNS;

/// Zero-state runner. The `(provider, model, thinking)` triple is read
/// live from `state::dispatch::snapshot()` on every dispatch, so
/// mid-session `/model` / `/effort` / provider swaps are always honored.
/// No cached triple, no boot capture.
pub struct InnerLoopRunner;

impl InnerLoopRunner {
    pub fn new() -> Arc<dyn SubagentRunner> {
        Arc::new(Self)
    }

    fn run_inner(
        &self,
        definition: &registry::AgentDefinition,
        prompt: &str,
        depth: u32,
        invocation: &AgentInvocation,
    ) -> Result<Value, RunnerError> {
        let started = std::time::Instant::now();
        let snap = crate::state::dispatch::snapshot().ok_or_else(|| {
            RunnerError::Internal(
                "dispatch snapshot not installed — the binary did not call `state::dispatch::install` at startup".into(),
            )
        })?;
        let model = crate::models::agents::resolve_agent_model(
            invocation.model.as_deref(),
            definition.model.as_deref(),
            &snap.model,
        );

        let provider = snap.provider.clone();
        let thinking = snap.thinking;
        tracing::info!(
            target: "otherside::dispatch",
            provider = provider.id(),
            model = %model,
            subagent_type = %definition.name,
            depth,
            "subagent dispatched"
        );
        let mut history: Vec<OpenAiChatMessage> = Vec::with_capacity(2);
        match provider.id() {
            "codex" => {
                history.push(OpenAiChatMessage {
                    role: OpenAiChatRole::System,
                    content: definition.system_prompt.clone(),
                    name: None,
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                    reasoning_content: None,
                    thinking_signature: None,
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
            reasoning_content: None,
            thinking_signature: None,
        });

        let provider_id = crate::config::providers::ProviderId::from_slug(provider.id())
            .unwrap_or(crate::config::providers::ProviderId::ClaudeCode);
        let dispatcher = GatedDispatcher::from_tools_field_with_provider(
            definition.tools.clone(),
            provider_id,
        );
        let emitter = super::current_nested_emitter();
        let observer = NestedObserver {
            emitter: emitter.unwrap_or_else(|| Arc::new(NullEmitter) as Arc<dyn NestedEmitter>),
        };
        // Advertise the tools the subagent is actually allowed to call.
        // Before this, tools: Vec::new() left the nested model unaware that
        // any tools existed — the gated dispatcher was ready to serve but
        // the model couldn't know to ask, so subagents could only produce
        // text and the user saw a "fake subagent" that never analyzed
        // anything. Upstream AgentTool wires per-subagent tools per the
        // `tools:` frontmatter field the same way.
        let subagent_tools = subagent_openai_tools(&definition.tools);
        let loop_ = AgentLoop {
            model: model.clone(),
            thinking,
            max_turns: SUBAGENT_MAX_TURNS,
            tools: subagent_tools,
            tool_choice: None,
            dispatcher,
            observer,
        };

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
        let total_tokens = loop_result
            .total_input_tokens
            .saturating_add(loop_result.total_output_tokens);
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
            "totalTokens": total_tokens,
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
                "input_tokens": loop_result.total_input_tokens,
                "output_tokens": loop_result.total_output_tokens,
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

fn subagent_openai_tools(
    allowed: &super::frontmatter::ToolsField,
) -> Vec<crate::inference::OpenAiToolDef> {
    use super::frontmatter::ToolsField;
    let full = crate::tools::openai_tools();
    match allowed {
        ToolsField::Wildcard => full,
        ToolsField::List(names) => full
            .into_iter()
            .filter(|t| names.iter().any(|n| n == &t.function.name))
            .collect(),
    }
}

struct NullEmitter;

impl NestedEmitter for NullEmitter {
    fn on_tool_start(&self, _name: &str, _args: &Value) {}
    fn on_tool_finish(&self, _success: bool) {}
    fn on_usage(&self, _input_tokens: Option<u64>, _output_tokens: Option<u64>) {}
}

