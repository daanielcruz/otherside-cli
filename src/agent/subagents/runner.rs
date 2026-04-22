

use std::sync::Arc;

use serde_json::{json, Value};

use crate::agent::{AgentLoop, ControlFlow, GatedDispatcher, LoopObserver, MAX_AUTO_TURNS};
use crate::error::Error;
use crate::inference::{OpenAiChatMessage, OpenAiChatRole};
use crate::provider::Provider;

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

    fn on_stream_error<'a>(&'a self, _err: &'a Error) -> impl std::future::Future<Output = ()> + Send + 'a {
        async move {}
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

        let dispatcher = GatedDispatcher::from_tools_field(definition.tools.clone());
        let emitter = super::current_nested_emitter();
        let observer = NestedObserver {
            emitter: emitter.unwrap_or_else(|| Arc::new(NullEmitter) as Arc<dyn NestedEmitter>),
        };
        let loop_ = AgentLoop {
            model: model.clone(),
            thinking: None,
            max_turns: SUBAGENT_MAX_TURNS,
            tools: Vec::new(),
            tool_choice: None,
            dispatcher,
            observer,
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

struct NullEmitter;

impl NestedEmitter for NullEmitter {
    fn on_tool_start(&self, _name: &str, _args: &Value) {}
    fn on_tool_finish(&self, _success: bool) {}
}

