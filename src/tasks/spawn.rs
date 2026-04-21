

use std::sync::Arc;

use serde_json::Value;

use crate::agent::subagents::{registry::AgentDefinition, AgentInvocation, SubagentRunner};

use super::{id::TaskId, state::TaskRecord, state::TaskState, store::TaskStore};

pub fn spawn_background_agent(
    runner: Arc<dyn SubagentRunner>,
    definition: AgentDefinition,
    prompt: String,
    depth: u32,
    invocation: AgentInvocation,
    store: TaskStore,
    display_name: String,
    tool_use_id: Option<String>,
) -> TaskId {
    let id = TaskId::generate();
    let mut record = TaskRecord::new_agent(id.clone(), display_name, prompt.clone());

    record.state = TaskState::Backgrounded;
    record.is_backgrounded = true;
    record.tool_use_id = tool_use_id;
    store.insert(record);

    let id_for_task = id.clone();
    let store_for_task = store.clone();
    tokio::task::spawn_blocking(move || {
        let result = runner.run(&definition, &prompt, depth, &invocation);
        finalize(&store_for_task, &id_for_task, result);
    });

    id
}

fn finalize(
    store: &TaskStore,
    id: &TaskId,
    result: Result<Value, crate::agent::subagents::RunnerError>,
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
        let id = spawn_background_agent(
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
        let id = spawn_background_agent(
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
        let id = spawn_background_agent(
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
