//! Subagent registry + runner plumbing for the `Agent` tool dispatcher.
//!
//! # Why this exists
//!
//! `tools::agent::agent` is a synchronous `fn(&Value) -> Result<Value, ToolError>`
//! (matches every other tool dispatcher). A real subagent turn, however, needs
//! async provider I/O + multi-turn orchestration (see `agent::AgentLoop`).
//!
//! This module hosts the bridge:
//!
//! - [`AgentDefinition`] — parsed frontmatter + prompt body (name, description,
//!   tools allowlist, model override, system prompt). Loaded from bundled
//!   `otherside-cli/agents/*.md` files at startup via [`registry::load_bundled`].
//! - [`SubagentRunner`] trait — the async entry the binary wires at startup.
//!   Takes a resolved `AgentDefinition`, the `prompt` from the tool call, and
//!   the current recursion depth; returns a structured result or a
//!   [`RunnerError`] the dispatcher serializes into `ToolError`.
//! - Global [`install_runner`] / [`current_runner`] — `OnceLock<Arc<dyn
//!   SubagentRunner>>`. Binary installs the real runner at startup; tests
//!   inject fakes.
//! - [`registry::resolve`] + [`registry::tool_is_allowed`] — type lookup and
//!   per-agent tool-subset enforcement.
//! - [`depth`] — thread-local recursion counter with `MAX_DEPTH = 3`.
//!
//! # Result shape
//!
//! Matches upstream's `agentToolResultSchema` (AgentTool/agentToolUtils.ts):
//! `{ agentId, agentType, content: [{type: "text", text}], totalToolUseCount,
//!   totalDurationMs, totalTokens, usage: {...} }`. Our MVP trims `usage` to
//! a minimal `{ input_tokens, output_tokens }` pair until the surrounding
//! plumbing carries the full cache ledger. The `tui::tool_render::agent_preview`
//! already reads `totalToolUseCount`, `totalTokens`, `totalDurationMs` off the
//! result, so rendering is zero-change.
//!
//! # Parallelism
//!
//! MVP runs sequentially. The schema reserves space for `run_in_background`
//! (upstream property) so parallel dispatch can land without breaking the wire
//! shape. Documented in `openspec/changes/020-agent-tool/design.md`.
//!
//! Zone: identity (R-103). No upstream product name strings in identifiers or
//! copy — the runner is a trait, agent defs describe behavior.

pub mod frontmatter;
pub mod registry;

use std::cell::Cell;
use std::sync::{Arc, OnceLock};

use serde_json::Value;

/// Maximum number of nested `Agent` dispatches permitted. A subagent may call
/// `Agent` itself, but only up to this depth from the top-level invocation.
/// Prevents runaway spawn loops when a model hands itself back a prompt that
/// re-invokes the same subagent type.
pub const MAX_DEPTH: u32 = 3;

/// Errors the runner surfaces to the dispatcher. The dispatcher maps every
/// variant to the appropriate `ToolError` so the model sees a consistent
/// result shape.
#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("subagent runner not installed — the binary did not call `subagents::install_runner` at startup")]
    NotInstalled,
    #[error("subagent type `{0}` is not registered")]
    UnknownType(String),
    #[error("subagent recursion depth exceeded (max {0})")]
    DepthExceeded(u32),
    #[error("runner internal error: {0}")]
    Internal(String),
}

/// Optional per-call overrides the upstream schema advertises on the
/// `Agent` tool: the model string, whether to run detached, and the
/// isolation mode (worktree vs cwd). Runners may honor or ignore each
/// field — they are wire-schema advertised so ignoring them silently
/// is fine, but the dispatcher must PASS them through so future
/// runners can pick them up without every call-site changing.
#[derive(Debug, Default, Clone)]
pub struct AgentInvocation {
    /// Model override (e.g. `"sonnet"`, `"haiku"`). None = inherit
    /// caller's active model.
    pub model: Option<String>,
    /// Run detached — caller gets back an agent id immediately instead
    /// of the final result. None = synchronous (upstream default).
    pub run_in_background: Option<bool>,
    /// Isolation mode. Upstream accepts `"worktree"`; everything else
    /// runs in the caller's cwd. None = caller's cwd.
    pub isolation: Option<String>,
}

/// Trait the binary implements at startup to wire the real subagent loop.
/// Tests provide a deterministic fake (see [`InlineFakeRunner`] below).
pub trait SubagentRunner: Send + Sync {
    /// Dispatch a resolved subagent. `definition` is the registry entry
    /// (tools allowlist + model override + system prompt body); `prompt` is
    /// the `prompt` arg from the tool call; `depth` is the current recursion
    /// depth BEFORE this subagent runs (0 at the top level). `invocation`
    /// carries per-call overrides (model, isolation, background) that
    /// upstream advertises on the tool schema — runners that don't
    /// implement those features yet may ignore the field.
    ///
    /// Returns the upstream-shape result map (see module docstring) or a
    /// [`RunnerError`].
    fn run(
        &self,
        definition: &registry::AgentDefinition,
        prompt: &str,
        depth: u32,
        invocation: &AgentInvocation,
    ) -> Result<Value, RunnerError>;
}

/// Lazily-set global runner. Binary calls `install_runner` once at startup;
/// a second call returns the existing runner (OnceLock semantics) — tests
/// that want to swap in a fake should use [`with_runner_for_test`] instead.
static RUNNER: OnceLock<Arc<dyn SubagentRunner>> = OnceLock::new();

/// Install the global runner. Returns `true` if this call set the value,
/// `false` if a runner was already installed (the existing one stays).
pub fn install_runner(runner: Arc<dyn SubagentRunner>) -> bool {
    RUNNER.set(runner).is_ok()
}

/// Fetch the current runner if installed.
pub fn current_runner() -> Option<Arc<dyn SubagentRunner>> {
    RUNNER.get().cloned()
}

thread_local! {
    static DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// Recursion-depth helpers. The dispatcher bumps on entry, decrements on
/// exit (RAII via [`DepthGuard`]) so nested `Agent` calls observe the
/// cumulative depth.
pub mod depth {
    use super::{DEPTH, MAX_DEPTH};

    /// Current depth (0 when no subagent is running).
    pub fn current() -> u32 {
        DEPTH.with(|d| d.get())
    }

    /// Try to push a new level. Returns `true` if the push fit under
    /// `MAX_DEPTH`, `false` otherwise (caller should reject the dispatch).
    pub fn push() -> bool {
        DEPTH.with(|d| {
            let next = d.get() + 1;
            if next > MAX_DEPTH {
                return false;
            }
            d.set(next);
            true
        })
    }

    /// Pop one level. Saturating — never underflows.
    pub fn pop() {
        DEPTH.with(|d| {
            let cur = d.get();
            if cur > 0 {
                d.set(cur - 1);
            }
        });
    }
}

/// RAII guard that pairs `depth::push` with `depth::pop`. Construct via
/// [`DepthGuard::try_push`]; returns `None` when the push would exceed
/// `MAX_DEPTH`.
pub struct DepthGuard;

impl DepthGuard {
    pub fn try_push() -> Option<Self> {
        if depth::push() {
            Some(Self)
        } else {
            None
        }
    }
}

impl Drop for DepthGuard {
    fn drop(&mut self) {
        depth::pop();
    }
}

/// Test-only runner helper — swaps a runner for the duration of the callback
/// using a fresh `OnceLock` via a trampoline. Not exposed outside `cfg(test)`
/// because the global `RUNNER` intentionally has set-once semantics for the
/// binary path.
#[cfg(test)]
pub fn with_runner_for_test<F, T>(runner: Arc<dyn SubagentRunner>, f: F) -> T
where
    F: FnOnce() -> T,
{
    // We can't reset the OnceLock, so tests rely on the fact that the first
    // `install_runner` call in a test process wins. Callers should use
    // `inline_fake` in-place for a deterministic injection.
    let _ = install_runner(runner);
    f()
}

/// Deterministic in-process runner used by tests (both the lib's
/// `#[cfg(test)]` module and out-of-crate integration tests under
/// `tests/`). Exposed unconditionally because integration tests compile
/// the crate without `cfg(test)`; the type carries no production behavior
/// beyond recording inputs + producing a configurable result shape.
#[derive(Default)]
pub struct InlineFakeRunner {
    pub content: std::sync::Mutex<String>,
    pub tool_uses: std::sync::atomic::AtomicU64,
    pub tokens: std::sync::atomic::AtomicU64,
    pub duration_ms: std::sync::atomic::AtomicU64,
    pub force_error: std::sync::Mutex<Option<RunnerError>>,
    pub last_prompt: std::sync::Mutex<Option<String>>,
    pub last_type: std::sync::Mutex<Option<String>>,
    pub last_depth: std::sync::atomic::AtomicU64,
}

impl InlineFakeRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_content(&self, s: impl Into<String>) {
        *self.content.lock().unwrap() = s.into();
    }

    pub fn set_tool_uses(&self, n: u64) {
        self.tool_uses
            .store(n, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn set_tokens(&self, n: u64) {
        self.tokens.store(n, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn set_duration(&self, ms: u64) {
        self.duration_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn force_error(&self, err: RunnerError) {
        *self.force_error.lock().unwrap() = Some(err);
    }
}

impl SubagentRunner for InlineFakeRunner {
    fn run(
        &self,
        definition: &registry::AgentDefinition,
        prompt: &str,
        depth: u32,
        _invocation: &AgentInvocation,
    ) -> Result<Value, RunnerError> {
        *self.last_prompt.lock().unwrap() = Some(prompt.to_string());
        *self.last_type.lock().unwrap() = Some(definition.name.clone());
        self.last_depth
            .store(depth as u64, std::sync::atomic::Ordering::Relaxed);
        if let Some(e) = self.force_error.lock().unwrap().take() {
            return Err(e);
        }
        let content = self.content.lock().unwrap().clone();
        let tool_uses = self.tool_uses.load(std::sync::atomic::Ordering::Relaxed);
        let tokens = self.tokens.load(std::sync::atomic::Ordering::Relaxed);
        let duration_ms = self.duration_ms.load(std::sync::atomic::Ordering::Relaxed);
        Ok(serde_json::json!({
            "status": "completed",
            "subagent_type": definition.name,
            "agentType": definition.name,
            "content": [{"type": "text", "text": content}],
            "totalToolUseCount": tool_uses,
            "totalTokens": tokens,
            "totalDurationMs": duration_ms,
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
            },
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn depth_push_and_pop_round_trip() {
        assert_eq!(depth::current(), 0);
        let g1 = DepthGuard::try_push().unwrap();
        assert_eq!(depth::current(), 1);
        let g2 = DepthGuard::try_push().unwrap();
        assert_eq!(depth::current(), 2);
        drop(g2);
        assert_eq!(depth::current(), 1);
        drop(g1);
        assert_eq!(depth::current(), 0);
    }

    #[test]
    fn depth_guard_rejects_at_cap() {
        let _g1 = DepthGuard::try_push().unwrap();
        let _g2 = DepthGuard::try_push().unwrap();
        let _g3 = DepthGuard::try_push().unwrap();
        // Fourth push would exceed MAX_DEPTH=3 → None.
        assert!(DepthGuard::try_push().is_none());
        assert_eq!(depth::current(), MAX_DEPTH);
    }

    #[test]
    fn pop_never_underflows() {
        depth::pop();
        depth::pop();
        assert_eq!(depth::current(), 0);
    }
}
