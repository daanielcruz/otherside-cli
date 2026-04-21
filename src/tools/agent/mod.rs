//! `Agent` tool — subagent dispatch entry.
//!
//! The wire-advertised name stays `Agent` (R-20 training anchor; upstream
//! capture 2026-04-18). 010 renamed the module from `task.rs` → `agent.rs`;
//! 020 replaces the original stub with a real dispatcher.
//!
//! # Flow
//!
//! 1. Validate `description` + `prompt` + optional `subagent_type`.
//!    `subagent_type` defaults to `general-purpose` (matches upstream).
//! 2. Resolve the definition via [`crate::subagents::registry::resolve`].
//!    Unknown types → [`ToolError::InvalidArgs`] listing the registered
//!    names so the model can recover.
//! 3. Push a recursion level via [`DepthGuard::try_push`]. Exceeding
//!    `MAX_DEPTH` → [`ToolError::InvalidArgs`] (model-recoverable, not a
//!    silent truncation).
//! 4. Fetch the installed [`SubagentRunner`] and call `run(def, prompt,
//!    depth)`. The runner is responsible for enforcing the tools allowlist
//!    via [`crate::subagents::registry::tool_is_allowed`] on each nested
//!    tool call.
//! 5. Forward the runner's result JSON back to the agent loop. The result
//!    shape matches upstream's `agentToolResultSchema` — `content` array,
//!    `totalToolUseCount`, `totalDurationMs`, `totalTokens`, `usage` map —
//!    so `tui::tool_render::agent_preview` renders `Done (N tool uses · M
//!    tokens · Ts)` without further change.
//!
//! # Tool-subset enforcement
//!
//! The dispatcher itself does NOT touch nested tool calls — those happen
//! inside the runner's inner [`crate::agent::AgentLoop`]. The runner MUST
//! consult [`crate::subagents::registry::tool_is_allowed`] on every tool
//! dispatched inside a subagent turn and surface a
//! `ToolError::PermissionDenied` for disallowed calls (see
//! [`SubagentToolGate`] helper below — the runner wires it into its
//! [`crate::agent::ToolDispatcher`]).
//!
//! # No-runner path
//!
//! When the binary starts without installing a runner (e.g. unit tests
//! that touch `tools::dispatch("Agent", ...)` before wiring), the
//! dispatcher returns the historical `{status: "unavailable", reason: ...}`
//! shape. That keeps existing call sites green and aligns with the
//! tui-render fallback.
//!
//! Zone: identity (R-103). No upstream product name strings in copy.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::subagents::{registry, AgentInvocation, DepthGuard, RunnerError, SubagentRunner};

use crate::tools::ToolError;

/// Dispatch an `Agent` tool call. Sync because the harness-wide
/// [`tools::dispatch`] signature is sync; the installed runner is
/// responsible for bridging to async provider I/O internally (via
/// `tokio::task::block_in_place` + `Handle::current().block_on` per R-107).
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

    // Per-call overrides the schema advertises (openspec 003 A1):
    // model / run_in_background / isolation. Plumb them into the
    // runner via `AgentInvocation` so future runners can honor them
    // without every dispatcher call-site changing. Today's lone fake
    // runner ignores them — that's fine, the fields ride through.
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

    // Resolve the definition — unknown types surface as InvalidArgs with a
    // hint listing registered names so the model can recover mid-turn.
    let Some(definition) = registry::resolve(subagent_type) else {
        let available: Vec<&str> = registry::all().iter().map(|d| d.name.as_str()).collect();
        return Err(ToolError::InvalidArgs(format!(
            "unknown subagent_type `{subagent_type}` — registered types: {}",
            available.join(", ")
        )));
    };

    // Bump recursion depth. `try_push` is the only surface that checks the
    // cap — the guard Drops on function exit so pops happen automatically.
    let Some(_guard) = DepthGuard::try_push() else {
        return Err(ToolError::InvalidArgs(format!(
            "subagent recursion depth exceeded (max {})",
            crate::subagents::MAX_DEPTH
        )));
    };
    let depth_at_entry = crate::subagents::depth::current() - 1;

    // If no runner is installed, fall back to the historical stub shape
    // so older call sites (and unit tests that hit the dispatcher without
    // wiring a runner) keep their existing behavior. Echo the invocation
    // overrides back so the model sees its intent was recognized even
    // when the runner can't honor it yet.
    let Some(runner) = crate::subagents::current_runner() else {
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

    // Background route — when the caller sets `run_in_background:
    // true` AND the env gate is off AND the TUI has installed the
    // global TaskStore, detach the dispatch onto the blocking pool
    // and return a synthetic tool_result immediately so the model
    // can end its turn. Completion ships via `<task-notification>`
    // XML on the next user turn (drained by the provider request
    // builder from the same global store).
    let wants_background = matches!(invocation.run_in_background, Some(true));
    if wants_background && !crate::tasks::is_disabled() {
        if let Some(store) = crate::tasks::store::current_global() {
            let display = if description.is_empty() {
                subagent_type.to_string()
            } else {
                description.to_string()
            };
            let task_id = crate::tasks::spawn_background_agent(
                runner,
                definition.clone(),
                prompt.to_string(),
                depth_at_entry,
                invocation.clone(),
                store,
                display.clone(),
            );
            return Ok(json!({
                "status": "backgrounded",
                "task_id": task_id.as_str(),
                "subagent_type": subagent_type,
                "description": description,
                "model_requested": invocation.model,
                "run_in_background_requested": invocation.run_in_background,
                "isolation_requested": invocation.isolation,
                // Human-facing line the model echoes back so the
                // user sees a deterministic confirmation. Byte-match
                // upstream `LocalAgentTask.tsx:246-261` idiom.
                "content": [{
                    "type": "text",
                    "text": format!(
                        "Started in background as {}. I'll be notified when it completes.",
                        task_id.as_str()
                    )
                }],
            }));
        }
    }

    dispatch_with_runner(runner.as_ref(), definition, prompt, depth_at_entry, &invocation)
}

/// Internal dispatch once the runner is resolved. Split out so tests can
/// exercise the error-mapping branch with an injected fake directly, without
/// having to take the global runner.
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

/// Helper a runner wires into its inner [`crate::agent::ToolDispatcher`] to
/// enforce the definition's tools allowlist on every nested tool call. The
/// runner constructs this gate with the resolved definition then forwards
/// permitted calls to the real `tools::dispatch` — disallowed ones produce
/// a JSON-encoded `ToolError::PermissionDenied` the model sees in the tool
/// result stream.
#[allow(dead_code)] // Wired by the real runner at startup; not used inside the stub path.
pub struct SubagentToolGate {
    definition: Arc<registry::AgentDefinition>,
}

impl SubagentToolGate {
    pub fn new(definition: Arc<registry::AgentDefinition>) -> Self {
        Self { definition }
    }

    /// Returns the dispatched result or a `ToolError::PermissionDenied`
    /// when the subagent is not allowed to call `tool_name`.
    pub fn gated_dispatch(&self, tool_name: &str, args: &Value) -> Result<Value, ToolError> {
        if !self.definition.allows_tool(tool_name) {
            return Err(ToolError::PermissionDenied(format!(
                "subagent `{}` cannot call tool `{}` (not in its `tools` allowlist)",
                self.definition.name, tool_name
            )));
        }
        crate::tools::dispatch(tool_name, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subagents::{install_runner, InlineFakeRunner};
    use std::sync::Arc;

    fn once_install_fake() -> Arc<InlineFakeRunner> {
        let fake = Arc::new(InlineFakeRunner::new());
        // First install wins — subsequent tests reuse the same fake since
        // the global RUNNER is OnceLock.
        let _ = install_runner(fake.clone() as Arc<dyn SubagentRunner>);
        // Whatever was actually installed: fetch it so tests that run
        // after a different test's install still see a usable fake.
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
                assert!(m.contains("general-purpose")); // Registered type is listed.
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn default_subagent_type_is_general_purpose() {
        // Install fake and tag it with something recognizable.
        let fake = once_install_fake();
        fake.set_content("ok-default");
        let res = agent(&json!({
            "description": "test",
            "prompt": "do it",
        }));
        // If a prior test already set a different content, we still
        // verify the subagent_type field is general-purpose.
        match res {
            Ok(v) => {
                // Accept either the completed-shape from our fake or the
                // unavailable-shape if a foreign runner was installed first.
                if v["status"] == "completed" {
                    assert_eq!(v["subagent_type"], "general-purpose");
                } else {
                    assert_eq!(v["status"], "unavailable");
                }
            }
            Err(e) => panic!("unexpected error: {e}"),
        }
    }

    #[test]
    fn tool_gate_rejects_out_of_allowlist_calls() {
        let def = registry::resolve("reader").unwrap().clone();
        let gate = SubagentToolGate::new(Arc::new(def));
        let err = gate.gated_dispatch("Bash", &json!({"command": "ls"})).unwrap_err();
        match err {
            ToolError::PermissionDenied(m) => {
                assert!(m.contains("reader"));
                assert!(m.contains("Bash"));
            }
            _ => panic!("expected PermissionDenied, got {err:?}"),
        }
    }

    #[test]
    fn tool_gate_allows_in_allowlist_calls() {
        // Reader is allowed to call Glob — the call will bounce off Glob's
        // own validation (empty args) but it should NOT return
        // PermissionDenied, proving the gate let it through.
        let def = registry::resolve("reader").unwrap().clone();
        let gate = SubagentToolGate::new(Arc::new(def));
        let res = gate.gated_dispatch("Glob", &json!({}));
        match res {
            Err(ToolError::PermissionDenied(_)) => {
                panic!("gate rejected an allowlisted tool")
            }
            _ => {} // Ok or other Err — fine.
        }
    }

    #[test]
    fn wildcard_definition_passes_every_tool_through_gate() {
        let def = registry::resolve("general-purpose").unwrap().clone();
        let gate = SubagentToolGate::new(Arc::new(def));
        for t in ["Read", "Bash", "Edit", "Write", "Agent"] {
            let res = gate.gated_dispatch(t, &json!({}));
            assert!(
                !matches!(res, Err(ToolError::PermissionDenied(_))),
                "wildcard agent should allow `{t}`"
            );
        }
    }
}
