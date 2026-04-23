

pub mod frontmatter;
pub mod registry;
pub mod runner;

pub use runner::InnerLoopRunner;

use std::cell::Cell;
use std::sync::{Arc, OnceLock};

use serde_json::Value;

pub const MAX_DEPTH: u32 = 3;

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

#[derive(Debug, Default, Clone)]
pub struct AgentInvocation {

    pub model: Option<String>,

    pub run_in_background: Option<bool>,

    pub isolation: Option<String>,
}

pub trait SubagentRunner: Send + Sync {

    fn run(
        &self,
        definition: &registry::AgentDefinition,
        prompt: &str,
        depth: u32,
        invocation: &AgentInvocation,
    ) -> Result<Value, RunnerError>;
}

pub trait NestedEmitter: Send + Sync {
    fn on_tool_start(&self, name: &str, args: &Value);
    fn on_tool_finish(&self, success: bool);
    fn on_usage(&self, input_tokens: Option<u64>, output_tokens: Option<u64>);
}

thread_local! {
    static NESTED_EMITTER: std::cell::RefCell<Option<Arc<dyn NestedEmitter>>> =
        const { std::cell::RefCell::new(None) };
}

pub fn with_nested_emitter<R>(emitter: Arc<dyn NestedEmitter>, f: impl FnOnce() -> R) -> R {
    NESTED_EMITTER.with(|cell| {
        let prev = cell.borrow_mut().replace(emitter);
        let out = f();
        *cell.borrow_mut() = prev;
        out
    })
}

pub fn current_nested_emitter() -> Option<Arc<dyn NestedEmitter>> {
    NESTED_EMITTER.with(|cell| cell.borrow().clone())
}

static RUNNER: OnceLock<Arc<dyn SubagentRunner>> = OnceLock::new();

pub fn install_runner(runner: Arc<dyn SubagentRunner>) -> bool {
    RUNNER.set(runner).is_ok()
}

pub fn current_runner() -> Option<Arc<dyn SubagentRunner>> {
    RUNNER.get().cloned()
}

thread_local! {
    static DEPTH: Cell<u32> = const { Cell::new(0) };
}

pub mod depth {
    use super::{DEPTH, MAX_DEPTH};

    pub fn current() -> u32 {
        DEPTH.with(|d| d.get())
    }

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

    pub fn pop() {
        DEPTH.with(|d| {
            let cur = d.get();
            if cur > 0 {
                d.set(cur - 1);
            }
        });
    }
}

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

#[cfg(test)]
pub fn with_runner_for_test<F, T>(runner: Arc<dyn SubagentRunner>, f: F) -> T
where
    F: FnOnce() -> T,
{

    let _ = install_runner(runner);
    f()
}

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
