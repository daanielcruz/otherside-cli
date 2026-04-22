

use std::sync::Arc;
use std::time::Duration;

use otherside::inference::OpenAiChatRequest;
use otherside::agent::subagents::frontmatter::ToolsField;
use otherside::agent::subagents::{
    registry::AgentDefinition, AgentInvocation, RunnerError, SubagentRunner,
};
use otherside::tasks::{
    spawn_background_agent,
    store::{current_global, install_global},
    TaskState, TaskStore,
};
use otherside::translator::anthropic::request::{build_request_body, UserContext};
use otherside::tui::state::ConversationState;
use serde_json::{json, Value};

struct BlockOnRunner {
    text: String,
}

impl SubagentRunner for BlockOnRunner {
    fn run(
        &self,
        definition: &AgentDefinition,
        _prompt: &str,
        depth: u32,
        invocation: &AgentInvocation,
    ) -> Result<Value, RunnerError> {
        let text = self.text.clone();
        let name = definition.name.clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async move {
                Ok(json!({
                    "status": "completed",
                    "subagent_type": name,
                    "agentType": name,
                    "content": [{"type": "text", "text": text}],
                    "totalToolUseCount": 0,
                    "totalTokens": 0,
                    "totalDurationMs": 0,
                    "depth": depth,
                    "model": "test-model",
                    "turnsTaken": 1,
                    "invocation": {
                        "model_requested": invocation.model,
                        "run_in_background_requested": invocation.run_in_background,
                        "isolation_requested": invocation.isolation,
                    },
                    "usage": {"input_tokens": 0, "output_tokens": 0},
                }))
            })
        })
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
async fn background_agent_auto_trigger_pipeline() {
    let store = install_global(TaskStore::new());

    let runner: Arc<dyn SubagentRunner> = Arc::new(BlockOnRunner {
        text: "agent finished its work".into(),
    });
    let id = spawn_background_agent(
        runner,
        def(),
        "summarize docs/roadmap.md".into(),
        0,
        AgentInvocation::default(),
        store.clone(),
        "test-agent".into(),
        Some("toolu_test_pipeline".into()),
    );
    let id_str = id.as_str().to_string();

    let mut done = false;
    for _ in 0..50 {
        if let Some(r) = store.get(&id) {
            if r.state == TaskState::Completed && r.inject_on_next_turn {
                done = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        done,
        "BG runner never reached Completed + inject_on_next_turn=true"
    );

    let mut st = ConversationState::new();
    let global = current_global().expect("global store installed");
    assert!(global.has_pending_notifications());

    let history = st
        .submit_auto_notification_turn(&global)
        .expect("auto-trigger should fire when pendings exist");

    assert!(st.streaming, "streaming must flip true after auto-trigger");
    assert!(
        st.request_started_at.is_some(),
        "request_started_at must be set"
    );
    assert!(
        !global.has_pending_notifications(),
        "drain must clear the flag"
    );

    let last_msg = st.messages.last().expect("synthetic user message present");
    assert!(
        last_msg.is_synthetic,
        "notification message must be flagged synthetic so render skips it"
    );
    assert!(
        last_msg.content.contains("<task-notification>"),
        "XML envelope missing from synthetic message content: {:?}",
        last_msg.content
    );
    assert!(
        last_msg.content.contains(&id_str),
        "task_id `{id_str}` missing from XML: {:?}",
        last_msg.content
    );
    assert!(
        last_msg.content.contains("<tool-use-id>toolu_test_pipeline"),
        "tool-use-id missing from XML: {:?}",
        last_msg.content
    );

    let req = OpenAiChatRequest {
        model: "test-model".into(),
        messages: history,
        ..Default::default()
    };
    let ctx = UserContext {
        email: "test@example.com",
        current_date: "2026-04-21",
        cwd: "/tmp/work",
        is_git_repo: false,
        platform: "darwin",
        shell: "bash",
        os_version: "Darwin 25.3.0",
        memory_dir: "/root/.otherside/projects/-tmp-work/memory/",
        git_status: "",
    };
    let body = build_request_body(&req, &ctx).expect("build_request_body");
    let body_str = std::str::from_utf8(&body).expect("body utf8");

    assert!(
        body_str.contains("<task-notification>"),
        "outbound body missing notification envelope"
    );
    assert!(
        body_str.contains(&id_str),
        "outbound body missing task id `{id_str}`"
    );
    assert!(
        body_str.contains("toolu_test_pipeline"),
        "outbound body missing tool_use_id"
    );

    let second = st.submit_auto_notification_turn(&global);
    assert!(
        second.is_none(),
        "second auto-trigger with empty pendings must return None"
    );
}
