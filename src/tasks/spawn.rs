//! Backgroundable spawn — bridge from the (sync) `SubagentRunner`
//! trait into the [`TaskStore`] without blocking the caller.
//!
//! Wave-1 §3 of openspec 015. The existing `SubagentRunner::run` is
//! sync (returns Result<Value, RunnerError>); the inner loop drives
//! itself through a `block_in_place + block_on` bridge inside the
//! runner. For backgrounding we need a path that returns immediately
//! to the TUI event loop and continues work on a tokio task.
//!
//! Solution: [`spawn_background_agent`] — generates a fresh
//! [`TaskId`], inserts a `Running`+`Agent`-kind record into the
//! store, then `tokio::task::spawn_blocking`s the runner's sync
//! `run` method. On completion the closure mutates the record into
//! a terminal state, sets `is_backgrounded = true`, flips
//! `inject_on_next_turn = true` so the wire layer ships a
//! `<task-notification>` block on the next user turn.
//!
//! Why `spawn_blocking` (not `tokio::spawn`):
//! the runner's `run` uses `block_in_place + Handle::current().
//! block_on(...)`, which only behaves correctly on a multi-thread
//! runtime AND only when the calling task itself is blocking. On
//! the main runtime worker the pattern is fine, but inside a normal
//! `tokio::spawn` it deadlocks on single-threaded runtimes. The
//! blocking pool is the safe home.
//!
//! # Returned id
//!
//! The caller (Agent tool dispatch with
//! `AgentInvocation.run_in_background = Some(true)`) gets the
//! id back immediately so the assistant message can render the
//! `Started in background as <id>. I'll be notified when it
//! completes.` line per upstream
//! `LocalAgentTask.tsx:246-261`.

use std::sync::Arc;

use serde_json::Value;

use crate::subagents::{registry::AgentDefinition, AgentInvocation, SubagentRunner};

use super::{id::TaskId, state::TaskRecord, state::TaskState, store::TaskStore};

/// Spawn an agent dispatch in the background.
///
/// Returns immediately with a fresh [`TaskId`]. The runner work
/// continues on the tokio blocking pool; on completion the store
/// transitions the record to a terminal state.
///
/// `display_name` is the human label rendered in the pill / dialog
/// — typically the subagent name (`definition.name`) or a short
/// summary derived from the prompt.
pub fn spawn_background_agent(
    runner: Arc<dyn SubagentRunner>,
    definition: AgentDefinition,
    prompt: String,
    depth: u32,
    invocation: AgentInvocation,
    store: TaskStore,
    display_name: String,
) -> TaskId {
    let id = TaskId::generate();
    let mut record = TaskRecord::new_agent(id.clone(), display_name, prompt.clone());
    // Background spawn → already in Backgrounded from frame zero.
    // The "Ctrl+B during a foreground turn" flow uses a different
    // path (`TaskStore::background_all_running_foreground`).
    record.state = TaskState::Backgrounded;
    record.is_backgrounded = true;
    store.insert(record);

    let id_for_task = id.clone();
    let store_for_task = store.clone();
    tokio::task::spawn_blocking(move || {
        let result = runner.run(&definition, &prompt, depth, &invocation);
        finalize(&store_for_task, &id_for_task, result);
    });

    id
}

/// Mutate the record per the runner's outcome — terminal state,
/// captured output, exit code, inject flag.
fn finalize(
    store: &TaskStore,
    id: &TaskId,
    result: Result<Value, crate::subagents::RunnerError>,
) {
    store.update_with(id, |r| {
        match result {
            Ok(v) => {
                let text = extract_assistant_text(&v);
                if !text.is_empty() {
                    r.push_output(text);
                }
                let status = v.get("status").and_then(Value::as_str).unwrap_or("");
                r.state = match status {
                    "completed" => TaskState::Completed,
                    "budget_exceeded" => TaskState::Stopped,
                    _ => TaskState::Completed,
                };
                r.exit_code = Some(0);
            }
            Err(e) => {
                r.push_output(format!("error: {e}"));
                r.state = TaskState::Failed;
                r.exit_code = Some(1);
            }
        }
        r.inject_on_next_turn = true;
    });
}

/// Pull the final assistant text from the upstream-shape result.
/// Mirrors what `tui::tool_render::agent_preview` reads.
fn extract_assistant_text(v: &Value) -> String {
    v.get("content")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subagents::frontmatter::ToolsField;
    use crate::subagents::{registry::AgentDefinition, AgentInvocation, RunnerError};
    use std::sync::Mutex;

    /// Deterministic fake — records call args, returns a canned
    /// result. Lets us drive `spawn_background_agent` end-to-end
    /// without spinning a real provider.
    struct FakeRunner {
        result: Mutex<Result<Value, RunnerError>>,
        last_prompt: Mutex<Option<String>>,
    }

    impl FakeRunner {
        fn ok(text: &str) -> Arc<Self> {
            Arc::new(Self {
                result: Mutex::new(Ok(serde_json::json!({
                    "status": "completed",
                    "content": [{"type": "text", "text": text}],
                }))),
                last_prompt: Mutex::new(None),
            })
        }

        fn err(msg: &str) -> Arc<Self> {
            Arc::new(Self {
                result: Mutex::new(Err(RunnerError::Internal(msg.into()))),
                last_prompt: Mutex::new(None),
            })
        }
    }

    impl SubagentRunner for FakeRunner {
        fn run(
            &self,
            _definition: &AgentDefinition,
            prompt: &str,
            _depth: u32,
            _invocation: &AgentInvocation,
        ) -> Result<Value, RunnerError> {
            *self.last_prompt.lock().unwrap() = Some(prompt.to_string());
            // Replace with a default Ok so subsequent calls (tests
            // that only spawn once) get a consistent value if we
            // ever loop. For our single-shot tests this just means
            // we read the original.
            std::mem::replace(
                &mut *self.result.lock().unwrap(),
                Err(RunnerError::Internal("already consumed".into())),
            )
        }
    }

    fn def() -> AgentDefinition {
        AgentDefinition {
            name: "test-agent".into(),
            description: "fake".into(),
            tools: ToolsField::Wildcard,
            model: None,
            system_prompt: "system".into(),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_returns_immediately_and_inserts_record() {
        let store = TaskStore::new();
        let runner: Arc<dyn SubagentRunner> = FakeRunner::ok("hello world");
        let started = std::time::Instant::now();
        let id = spawn_background_agent(
            runner,
            def(),
            "hi".into(),
            0,
            AgentInvocation::default(),
            store.clone(),
            "test-agent".into(),
        );
        // Caller-visible latency: spawn_blocking returns the moment
        // the closure is scheduled — well under the 100ms gate.
        assert!(started.elapsed().as_millis() < 100);
        // Record exists in the store immediately. State may already
        // have transitioned to terminal because the fake runner is
        // instant on a multi-thread runtime — checking persistence
        // not transient state.
        let r = store.get(&id).expect("record present immediately");
        assert!(r.is_backgrounded, "background spawn always sets is_backgrounded");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_transitions_to_completed_with_output() {
        let store = TaskStore::new();
        let runner: Arc<dyn SubagentRunner> = FakeRunner::ok("agent output");
        let id = spawn_background_agent(
            runner,
            def(),
            "hi".into(),
            0,
            AgentInvocation::default(),
            store.clone(),
            "test-agent".into(),
        );
        // Wait for the blocking task to settle. 200ms is plenty for
        // the fake runner — it doesn't await anything.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let r = store.get(&id).expect("record");
        assert_eq!(r.state, TaskState::Completed);
        assert!(r.inject_on_next_turn, "completion must flag for next-turn injection");
        assert_eq!(r.exit_code, Some(0));
        let captured: Vec<&str> = r.output.iter().map(String::as_str).collect();
        assert_eq!(captured, vec!["agent output"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_transitions_to_failed_on_runner_error() {
        let store = TaskStore::new();
        let runner: Arc<dyn SubagentRunner> = FakeRunner::err("boom");
        let id = spawn_background_agent(
            runner,
            def(),
            "hi".into(),
            0,
            AgentInvocation::default(),
            store.clone(),
            "test-agent".into(),
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let r = store.get(&id).expect("record");
        assert_eq!(r.state, TaskState::Failed);
        assert_eq!(r.exit_code, Some(1));
        assert!(r.inject_on_next_turn);
    }
}
