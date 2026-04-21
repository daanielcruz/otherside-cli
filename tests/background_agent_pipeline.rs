//! Integration test — openspec 015 §9 background-agent pipeline,
//! end-to-end from spawn through the next-turn `<task-notification>`
//! injection into the outgoing `/v1/messages` body.
//!
//! Stages exercised:
//!
//! 1. Install the process-global [`TaskStore`].
//! 2. Spawn an agent dispatch via [`spawn_background_agent`] with a
//!    test runner that mirrors the real [`InnerLoopRunner`] sync→async
//!    pattern (`tokio::task::block_in_place` +
//!    `Handle::current().block_on`).
//! 3. Poll the store until the record reaches `Completed` —
//!    proves the spawn pivot didn't swallow a panic.
//! 4. Replicate `provider::anthropic::stream`'s drain step:
//!    `current_global() → drain_pending_notifications() → render`.
//! 5. Build the `/v1/messages` body via [`build_request_body`] with
//!    a synthetic next user turn ("did it finish?").
//! 6. Assert the body string contains:
//!    - the `<task-notification>` envelope
//!    - the spawned task id
//!    - the next-turn user content (proves no clobber)
//!
//! Failure mode this test guards against: silent breakage anywhere
//! along the spawn → finalize → drain → inject chain. Earlier unit
//! tests cover each link in isolation; this one wires them together.

use std::sync::Arc;
use std::time::Duration;

use otherside::harness::task_notification;
use otherside::inference::{OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole};
use otherside::subagents::frontmatter::ToolsField;
use otherside::subagents::{
    registry::AgentDefinition, AgentInvocation, RunnerError, SubagentRunner,
};
use otherside::tasks::{
    spawn_background_agent,
    store::{current_global, install_global},
    TaskState, TaskStore,
};
use otherside::translator::anthropic::request::{build_request_body, UserContext};
use serde_json::{json, Value};

/// Mirrors the real `InnerLoopRunner::run_inner` sync→async bridge
/// — `block_in_place` + `Handle::current().block_on`. Keeps the
/// spawn-thread shape honest: if the production runner pattern
/// breaks the spawn pivot, this test catches it.
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
async fn background_agent_pipeline_emits_task_notification_on_next_turn() {
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

    let mut state = None;
    for _ in 0..50 {
        if let Some(r) = store.get(&id) {
            if r.state == TaskState::Completed {
                state = Some(r);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let record =
        state.expect("background agent never reached Completed state — spawn pivot likely broken");
    assert!(
        record.inject_on_next_turn,
        "completion must flag inject_on_next_turn for the next-turn drain"
    );

    let task_notifications: Vec<String> = current_global()
        .map(|s| {
            s.drain_pending_notifications()
                .into_iter()
                .map(|r| {
                    let output_path = format!("~/.otherside/tasks/{}.log", r.id.as_str());
                    task_notification::render(&r, &output_path, Default::default())
                })
                .collect()
        })
        .unwrap_or_default();
    assert!(
        !task_notifications.is_empty(),
        "drain_pending_notifications returned empty after Completed record"
    );
    let xml = &task_notifications[0];
    assert!(
        xml.contains("<task-notification>"),
        "rendered XML missing envelope"
    );
    assert!(
        xml.contains(&id_str),
        "rendered XML missing task id `{id_str}`: `{xml}`"
    );
    assert!(
        xml.contains("<status>completed</status>"),
        "rendered XML missing completed status: `{xml}`"
    );

    let req = OpenAiChatRequest {
        model: "test-model".into(),
        messages: vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: "did it finish?".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let ctx = UserContext {
        email: "test@example.com",
        current_date: "2026-04-20",
        cwd: "/tmp/work",
        is_git_repo: false,
        platform: "darwin",
        shell: "bash",
        os_version: "Darwin 25.3.0",
        task_notifications: &task_notifications,
    };
    let body = build_request_body(&req, &ctx).expect("build_request_body");
    let body_str = std::str::from_utf8(&body).expect("body utf8");

    assert!(
        body_str.contains("<task-notification>"),
        "outgoing body missing notification envelope; first 500 bytes: `{}`",
        &body_str.chars().take(500).collect::<String>()
    );
    assert!(
        body_str.contains(&id_str),
        "outgoing body missing task id `{id_str}`"
    );
    assert!(
        body_str.contains("did it finish?"),
        "outgoing body lost the next-turn user prompt"
    );
}
