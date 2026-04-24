
use std::sync::Arc;

use serde_json::Value;

use crate::agent::subagents::{
    registry::AgentDefinition, AgentInvocation, NestedEmitter, SubagentRunner,
};

use super::{
    id::TaskId, state::TaskDisplayMode, state::TaskRecord, state::TaskState, store::TaskStore,
};

struct BgProgressEmitter {
    store: TaskStore,
    task_id: TaskId,
}

impl NestedEmitter for BgProgressEmitter {
    fn on_tool_start(&self, name: &str, args: &Value) {
        let line = crate::tui::state::format_progress_line(name, args);
        self.store.push_progress_line(&self.task_id, line);
    }

    fn on_tool_finish(&self, _success: bool) {}

    fn on_usage(&self, input_tokens: Option<u64>, output_tokens: Option<u64>) {
        let delta = input_tokens.unwrap_or(0).saturating_add(output_tokens.unwrap_or(0));
        if delta > 0 {
            self.store.accumulate_tokens(&self.task_id, delta);
        }
    }
}

pub struct SpawnOutcome {
    pub task_id: TaskId,
    
    pub agent_id: String,
}

pub fn spawn_background_agent(
    runner: Arc<dyn SubagentRunner>,
    definition: AgentDefinition,
    prompt: String,
    depth: u32,
    mut invocation: AgentInvocation,
    store: TaskStore,
    display_name: String,
    tool_use_id: Option<String>,
) -> SpawnOutcome {
    let id = TaskId::generate();
    let agent_id = super::id::create_agent_id(None);
    let mut record = TaskRecord::new_agent(id.clone(), display_name.clone(), prompt.clone());

    record.state = TaskState::Backgrounded;
    record.is_backgrounded = true;
    record.tool_use_id = tool_use_id.clone();
    record.agent_id = Some(agent_id.clone());
    record.subagent_type = Some(definition.name.clone());
    if display_name != definition.name {
        record.description = Some(display_name);
    }
    store.insert(record);

    let cancel_key = tool_use_id.clone();
    if let Some(key) = cancel_key.as_deref() {
        let flag = crate::tools::background_signal::register_bg(key);
        invocation.cancel = Some(flag);
    }

    let id_for_task = id.clone();
    let store_for_task = store.clone();
    let bg_emitter: Arc<dyn NestedEmitter> = Arc::new(BgProgressEmitter {
        store: store.clone(),
        task_id: id.clone(),
    });
    tokio::task::spawn_blocking(move || {
        let result = crate::agent::subagents::with_nested_emitter(bg_emitter, || {
            runner.run(&definition, &prompt, depth, &invocation)
        });
        if let Some(key) = cancel_key.as_deref() {
            crate::tools::background_signal::unregister_bg(key);
        }
        finalize(&store_for_task, &id_for_task, result);
    });

    SpawnOutcome { task_id: id, agent_id }
}

pub fn spawn_forked_skill_agent(
    runner: Arc<dyn SubagentRunner>,
    definition: AgentDefinition,
    prompt: String,
    mut invocation: AgentInvocation,
    store: TaskStore,
    display_name: String,
    anchor_id: String,
) -> SpawnOutcome {
    let id = TaskId::generate();
    let agent_id = super::id::create_agent_id(None);
    let mut record = TaskRecord::new_agent(id.clone(), display_name.clone(), prompt.clone());
    record.state = TaskState::Running;
    record.is_backgrounded = false;
    record.agent_id = Some(agent_id.clone());
    record.subagent_type = Some(definition.name.clone());
    record.display_mode = TaskDisplayMode::InlineAnchor;
    record.anchor_id = Some(anchor_id.clone());
    if display_name != definition.name {
        record.description = Some(display_name);
    }
    store.insert(record);

    let cancel_key = anchor_id.clone();
    let flag = crate::tools::background_signal::register_bg(&cancel_key);
    invocation.cancel = Some(flag);

    let id_for_task = id.clone();
    let store_for_task = store.clone();
    let bg_emitter: Arc<dyn NestedEmitter> = Arc::new(BgProgressEmitter {
        store: store.clone(),
        task_id: id.clone(),
    });
    tokio::task::spawn_blocking(move || {
        let result = crate::agent::subagents::with_nested_emitter(bg_emitter, || {
            runner.run(&definition, &prompt, 0, &invocation)
        });
        crate::tools::background_signal::unregister_bg(&cancel_key);
        finalize(&store_for_task, &id_for_task, result);
    });

    SpawnOutcome { task_id: id, agent_id }
}

fn finalize(
    store: &TaskStore,
    id: &TaskId,
    result: Result<Value, crate::agent::subagents::RunnerError>,
) {
    
    let mut disk_payload: Option<(String, String)> = None;

    store.update_with(id, |r| {
        match result {
            Ok(v) => {
                let text = extract_assistant_text(&v);
                if !text.is_empty() {
                    r.push_output(text.clone());
                    if let Some(agent_id) = r.agent_id.as_ref() {
                        disk_payload = Some((agent_id.clone(), text));
                    }
                }
                
                if let Some(total) = v.get("totalTokens").and_then(Value::as_u64) {
                    r.tokens = total;
                }
                if let Some(tu) = v.get("totalToolUseCount").and_then(Value::as_u64) {
                    r.tool_uses = tu;
                }
                if let Some(dur) = v.get("totalDurationMs").and_then(Value::as_u64) {
                    r.duration_ms = dur;
                } else {
                    r.duration_ms = r.started_at.elapsed().as_millis() as u64;
                }
                let status = v.get("status").and_then(Value::as_str).unwrap_or("");
                r.state = match status {
                    "completed" => TaskState::Completed,
                    "budget_exceeded" | "stopped" => TaskState::Stopped,
                    _ => TaskState::Completed,
                };
                r.exit_code = Some(0);
            }
            Err(e) => {
                let err_line = format!("error: {e}");
                r.push_output(err_line.clone());
                if let Some(agent_id) = r.agent_id.as_ref() {
                    disk_payload = Some((agent_id.clone(), err_line));
                }
                r.error = Some(e.to_string());
                r.state = TaskState::Failed;
                r.exit_code = Some(1);
                r.duration_ms = r.started_at.elapsed().as_millis() as u64;
            }
        }
        r.inject_on_next_turn = matches!(r.display_mode, TaskDisplayMode::Panel);
    });

    if let Some((agent_id, text)) = disk_payload {
        
        if let Err(e) = super::disk_output::write_task_output(&agent_id, &text) {
            tracing::warn!(?e, agent_id, "task-output mirror failed");
        }
    }
}

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
    use crate::agent::subagents::frontmatter::ToolsField;
    use crate::agent::subagents::{registry::AgentDefinition, AgentInvocation, RunnerError};
    use std::sync::Mutex;

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
        let SpawnOutcome { task_id: id, .. } = spawn_background_agent(
            runner,
            def(),
            "hi".into(),
            0,
            AgentInvocation::default(),
            store.clone(),
            "test-agent".into(),
            Some("toolu_test".into()),
        );

        assert!(started.elapsed().as_millis() < 100);

        let r = store.get(&id).expect("record present immediately");
        assert!(r.is_backgrounded, "background spawn always sets is_backgrounded");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_transitions_to_completed_with_output() {
        let store = TaskStore::new();
        let runner: Arc<dyn SubagentRunner> = FakeRunner::ok("agent output");
        let SpawnOutcome { task_id: id, .. } = spawn_background_agent(
            runner,
            def(),
            "hi".into(),
            0,
            AgentInvocation::default(),
            store.clone(),
            "test-agent".into(),
            Some("toolu_test".into()),
        );

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let r = store.get(&id).expect("record");
        assert_eq!(r.state, TaskState::Completed);
        assert!(r.inject_on_next_turn, "completion must flag for next-turn injection");
        assert_eq!(r.exit_code, Some(0));
        let captured: Vec<&str> = r.output.iter().map(String::as_str).collect();
        assert_eq!(captured, vec!["agent output"]);
    }

    struct TokenRunner;

    impl SubagentRunner for TokenRunner {
        fn run(
            &self,
            _definition: &AgentDefinition,
            _prompt: &str,
            _depth: u32,
            _invocation: &AgentInvocation,
        ) -> Result<Value, RunnerError> {
            Ok(serde_json::json!({
                "status": "completed",
                "content": [{"type": "text", "text": "done"}],
                "totalTokens": 22_345u64,
            }))
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn finalize_propagates_total_tokens_into_record() {
        let store = TaskStore::new();
        let runner: Arc<dyn SubagentRunner> = Arc::new(TokenRunner);
        let SpawnOutcome { task_id: id, .. } = spawn_background_agent(
            runner,
            def(),
            "hi".into(),
            0,
            AgentInvocation::default(),
            store.clone(),
            "test-agent".into(),
            Some("toolu_test".into()),
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let r = store.get(&id).expect("record");
        assert_eq!(
            r.tokens, 22_345,
            "finalize must carry runner totalTokens into TaskRecord.tokens — parity Fix 8"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_transitions_to_failed_on_runner_error() {
        let store = TaskStore::new();
        let runner: Arc<dyn SubagentRunner> = FakeRunner::err("boom");
        let SpawnOutcome { task_id: id, .. } = spawn_background_agent(
            runner,
            def(),
            "hi".into(),
            0,
            AgentInvocation::default(),
            store.clone(),
            "test-agent".into(),
            Some("toolu_test".into()),
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let r = store.get(&id).expect("record");
        assert_eq!(r.state, TaskState::Failed);
        assert_eq!(r.exit_code, Some(1));
        assert!(r.inject_on_next_turn);
    }

    struct BlockInPlaceRunner;

    impl SubagentRunner for BlockInPlaceRunner {
        fn run(
            &self,
            _definition: &AgentDefinition,
            _prompt: &str,
            _depth: u32,
            _invocation: &AgentInvocation,
        ) -> Result<Value, RunnerError> {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async move {
                    Ok(serde_json::json!({
                        "status": "completed",
                        "content": [{"type": "text", "text": "block_in_place ok"}],
                    }))
                })
            })
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_handles_block_in_place_runner_pattern() {
        let store = TaskStore::new();
        let runner: Arc<dyn SubagentRunner> = Arc::new(BlockInPlaceRunner);
        let SpawnOutcome { task_id: id, .. } = spawn_background_agent(
            runner,
            def(),
            "hi".into(),
            0,
            AgentInvocation::default(),
            store.clone(),
            "test-agent".into(),
            Some("toolu_test".into()),
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let r = store.get(&id).expect("record present");
        assert_eq!(
            r.state,
            TaskState::Completed,
            "runner using block_in_place must reach Completed; if stuck in Backgrounded the spawn pivot panicked silently"
        );
        assert!(
            r.inject_on_next_turn,
            "completion must flag inject_on_next_turn so the next user turn ships <task-notification>"
        );
        let captured: Vec<&str> = r.output.iter().map(String::as_str).collect();
        assert_eq!(captured, vec!["block_in_place ok"]);
    }
}
