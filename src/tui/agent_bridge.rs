use std::future::Future;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::agent::subagents::NestedEmitter;
use crate::agent::{ControlFlow, LoopObserver, ToolDispatcher, MAX_AUTO_TURNS};
use crate::config::settings::{PermissionMode, Settings};
use crate::error::{Error, Result};
use crate::permissions::{self, Decision, PermissionResponse, RuntimePermissionGrants};
use crate::tools::{self, ToolError};

use super::StreamEvent;

struct StreamEmitter {
    tx: mpsc::Sender<StreamEvent>,
}

impl NestedEmitter for StreamEmitter {
    fn on_tool_start(&self, name: &str, args: &Value) {
        let _ = self.tx.try_send(StreamEvent::NestedToolStart {
            name: name.to_string(),
            args: args.clone(),
        });
    }

    fn on_tool_finish(&self, success: bool) {
        let _ = self.tx.try_send(StreamEvent::NestedToolFinish { success });
    }

    fn on_usage(&self, input_tokens: Option<u64>, output_tokens: Option<u64>) {
        let _ = self.tx.try_send(StreamEvent::NestedUsage {
            input_tokens,
            output_tokens,
        });
    }
}

pub(super) struct TuiDispatcher {
    pub tx: mpsc::Sender<StreamEvent>,
    pub settings: Arc<Settings>,
    pub mode: PermissionMode,
    pub session_allowlist: RuntimePermissionGrants,
    pub provider_id: crate::config::providers::ProviderId,
}

impl ToolDispatcher for TuiDispatcher {
    fn dispatch<'a>(
        &'a self,
        tool_call_id: &'a str,
        name: &'a str,
        args: &'a Value,
    ) -> impl Future<Output = Result<Value>> + Send + 'a {
        async move {
            match dispatch_with_prompt(
                name,
                args,
                tool_call_id,
                &self.settings,
                self.mode,
                &self.session_allowlist,
                &self.tx,
                self.provider_id,
            )
            .await
            {
                Ok(v) => Ok(v),
                Err(e) => Err(Error::Other(format!("{e}"))),
            }
        }
    }
}

pub(super) struct TuiObserver {
    pub tx: mpsc::Sender<StreamEvent>,
}

impl LoopObserver for TuiObserver {
    fn on_delta<'a>(&'a self, delta: &'a str) -> impl Future<Output = ControlFlow> + Send + 'a {
        let delta = delta.to_string();
        async move {
            tracing::trace!(
                target: "otherside::stream",
                hop = "tui_delta_send",
                len = delta.len(),
                "StreamEvent::Delta dispatching to TUI rx"
            );
            if self.tx.send(StreamEvent::Delta(delta)).await.is_err() {
                ControlFlow::Abort
            } else {
                ControlFlow::Continue
            }
        }
    }

    fn on_usage(
        &self,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> impl Future<Output = ControlFlow> + Send + '_ {
        async move {
            if self
                .tx
                .send(StreamEvent::Usage {
                    input_tokens,
                    output_tokens,
                })
                .await
                .is_err()
            {
                ControlFlow::Abort
            } else {
                ControlFlow::Continue
            }
        }
    }

    fn on_tool_start<'a>(
        &'a self,
        id: &'a str,
        name: &'a str,
        args: &'a Value,
    ) -> impl Future<Output = ControlFlow> + Send + 'a {
        let id = id.to_string();
        let name = name.to_string();
        let args = args.clone();
        async move {
            if self
                .tx
                .send(StreamEvent::ToolCallStart { id, name, args })
                .await
                .is_err()
            {
                ControlFlow::Abort
            } else {
                ControlFlow::Continue
            }
        }
    }

    fn on_tool_finish<'a>(
        &'a self,
        id: &'a str,
        _name: &'a str,
        result: std::result::Result<&'a Value, &'a str>,
        elapsed_ms: u64,
    ) -> impl Future<Output = ControlFlow> + Send + 'a {
        let id = id.to_string();
        let finish_result = match result {
            Ok(v) => Ok(v.clone()),
            Err(s) => Err(s.to_string()),
        };
        async move {
            if self
                .tx
                .send(StreamEvent::ToolCallFinish {
                    id,
                    result: finish_result,
                    elapsed_ms,
                })
                .await
                .is_err()
            {
                ControlFlow::Abort
            } else {
                ControlFlow::Continue
            }
        }
    }

    fn on_turn_limit(&self, max_turns: u32) -> impl Future<Output = ()> + Send + '_ {
        async move {
            let _ = self
                .tx
                .send(StreamEvent::Delta(format!(
                    "\n(auto-turn limit of {max_turns} reached — returning control)\n"
                )))
                .await;
        }
    }

    fn on_stream_error<'a>(&'a self, err: &'a Error) -> impl Future<Output = ()> + Send + 'a {
        let msg = format_err(err);
        async move {
            let _ = self.tx.send(StreamEvent::Error(msg)).await;
        }
    }
}

pub(super) const _MAX_AUTO_TURNS: u32 = MAX_AUTO_TURNS;

async fn dispatch_with_prompt(
    tool_name: &str,
    args: &Value,
    tool_call_id: &str,
    settings: &Settings,
    mode: PermissionMode,
    session_allowlist: &RuntimePermissionGrants,
    tx: &mpsc::Sender<StreamEvent>,
    provider_id: crate::config::providers::ProviderId,
) -> std::result::Result<Value, ToolError> {
    if tool_name == "AskUserQuestion" {
        return ask_user_question_async(args, tx).await;
    }

    let input_str = tools::matcher_input_for(tool_name, args);

    let mut composed = settings.clone();
    overlay_session_allowlist(&mut composed, session_allowlist);

    async fn run_dispatch(
        tool_name: &str,
        args: &Value,
        tool_call_id: &str,
        tx: &mpsc::Sender<StreamEvent>,
        provider_id: crate::config::providers::ProviderId,
    ) -> std::result::Result<Value, ToolError> {
        if tool_name == "Agent" {
            dispatch_agent_cancellable(tool_name, args, tool_call_id, tx, provider_id).await
        } else {
            tools::with_current_provider(provider_id, || {
                tools::with_tool_call_id(tool_call_id.to_string(), || {
                    tools::dispatch(tool_name, args)
                })
            })
        }
    }

    match permissions::resolve(tool_name, &input_str, &composed, mode) {
        Decision::Allow => run_dispatch(tool_name, args, tool_call_id, tx, provider_id).await,
        Decision::Deny { rule } => Err(ToolError::PermissionDenied(rule)),
        Decision::Ask { rule } => {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            let args_preview = preview_args_for_prompt(tool_name, args);
            if tx
                .send(StreamEvent::PermissionAsk {
                    tool_name: tool_name.to_string(),
                    args_preview,
                    rule: rule.clone(),
                    reply: reply_tx,
                })
                .await
                .is_err()
            {
                return Err(ToolError::PermissionDenied(
                    "user interface gone — aborting call".into(),
                ));
            }
            match reply_rx.await {
                Ok(PermissionResponse::Allow)
                | Ok(PermissionResponse::AllowSession)
                | Ok(PermissionResponse::AllowAlways) => {
                    run_dispatch(tool_name, args, tool_call_id, tx, provider_id).await
                }
                Ok(PermissionResponse::Deny) => Err(ToolError::PermissionDenied(
                    rule.unwrap_or_else(|| "user declined".into()),
                )),
                Err(_) => Err(ToolError::PermissionDenied(
                    "permission prompt cancelled".into(),
                )),
            }
        }
    }
}

async fn dispatch_agent_cancellable(
    tool_name: &str,
    args: &Value,
    tool_call_id: &str,
    tx: &mpsc::Sender<StreamEvent>,
    provider_id: crate::config::providers::ProviderId,
) -> std::result::Result<Value, ToolError> {
    use crate::tools::background_signal;

    let mut cancel_rx = background_signal::register(tool_call_id);

    let name_owned = tool_name.to_string();
    let args_owned = args.clone();
    let call_id_owned = tool_call_id.to_string();
    let tx_for_emitter = tx.clone();

    let mut join = tokio::task::spawn_blocking(move || {
        let emitter: Arc<dyn NestedEmitter> = Arc::new(StreamEmitter { tx: tx_for_emitter });
        crate::agent::subagents::with_nested_emitter(emitter, || {
            
            tools::with_current_provider(provider_id, || {
                tools::with_tool_call_id(call_id_owned, || {
                    tools::dispatch(&name_owned, &args_owned)
                })
            })
        })
    });

    let completion: Option<std::result::Result<
        std::result::Result<Value, ToolError>,
        tokio::task::JoinError,
    >> = tokio::select! {
        biased;
        _ = cancel_rx.changed() => None,
        result = &mut join => Some(result),
    };

    if let Some(join_result) = completion {
        background_signal::unregister(tool_call_id);
        return match join_result {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(e),
            Err(e) => Err(ToolError::InvalidArgs(format!("agent join error: {e}"))),
        };
    }

    background_signal::unregister(tool_call_id);
    let subagent_type = args
        .get("subagent_type")
        .and_then(|v| v.as_str())
        .unwrap_or("general-purpose");
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let agent_id = {
        let store_opt = crate::tasks::store::current_global();
        let task_id = store_opt
            .as_ref()
            .and_then(|s| s.task_id_by_tool_use_id(tool_call_id));
        let existing = task_id
            .as_ref()
            .and_then(|tid| store_opt.as_ref().and_then(|s| s.get(tid)))
            .and_then(|r| r.agent_id.clone());
        existing.unwrap_or_else(|| {
            let generated = crate::tasks::id::create_agent_id(None);
            if let (Some(store), Some(tid)) = (store_opt.as_ref(), task_id.as_ref()) {
                store.update_with(tid, |r| {
                    r.agent_id.get_or_insert(generated.clone());
                });
            }
            generated
        })
    };

    let call_id_for_late = tool_call_id.to_string();
    let tx_for_late = tx.clone();
    let agent_id_for_late = agent_id.clone();
    tokio::spawn(async move {
        let outcome = join.await;
        let store_opt = crate::tasks::store::current_global();
        let task_id = match store_opt
            .as_ref()
            .and_then(|s| s.task_id_by_tool_use_id(&call_id_for_late))
        {
            Some(tid) => tid,
            None => return,
        };

        match outcome {
            Ok(Ok(v)) => {
                let text = v
                    .get("content")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|first| first.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                let total_tokens = v.get("totalTokens").and_then(Value::as_u64);
                let total_tool_uses = v.get("totalToolUseCount").and_then(Value::as_u64);
                let total_duration = v.get("totalDurationMs").and_then(Value::as_u64);

                if !text.is_empty() {
                    if let Err(e) = crate::tasks::disk_output::write_task_output(
                        &agent_id_for_late,
                        &text,
                    ) {
                        tracing::warn!(
                            ?e,
                            agent_id = %agent_id_for_late,
                            "ctrl+b handoff: disk-output mirror failed"
                        );
                    }
                }

                if let Some(store) = store_opt.as_ref() {
                    store.update_with(&task_id, |r| {
                        if !text.is_empty() {
                            r.push_output(text);
                        }
                        if let Some(total) = total_tokens {
                            r.tokens = total;
                        }
                        if let Some(tu) = total_tool_uses {
                            r.tool_uses = tu;
                        }
                        r.duration_ms = total_duration
                            .unwrap_or_else(|| r.started_at.elapsed().as_millis() as u64);
                        if !r.state.is_terminal() {
                            r.state = crate::tasks::TaskState::Completed;
                            r.exit_code = Some(0);
                        }
                        r.inject_on_next_turn = true;
                    });
                }
            }
            Ok(Err(e)) => {
                let err_line = format!("error: {e}");
                let err_string = e.to_string();
                if let Some(store) = store_opt.as_ref() {
                    store.update_with(&task_id, |r| {
                        r.push_output(err_line.clone());
                        r.error = Some(err_string.clone());
                        r.duration_ms = r.started_at.elapsed().as_millis() as u64;
                        if !r.state.is_terminal() {
                            r.state = crate::tasks::TaskState::Failed;
                            r.exit_code = Some(1);
                        }
                        r.inject_on_next_turn = true;
                    });
                }
            }
            Err(e) => {
                let err_line = format!("join error: {e}");
                if let Some(store) = store_opt.as_ref() {
                    store.update_with(&task_id, |r| {
                        r.push_output(err_line.clone());
                        r.error = Some(format!("join error: {e}"));
                        r.duration_ms = r.started_at.elapsed().as_millis() as u64;
                        if !r.state.is_terminal() {
                            r.state = crate::tasks::TaskState::Failed;
                            r.exit_code = Some(1);
                        }
                        r.inject_on_next_turn = true;
                    });
                }
            }
        }

        let _ = call_id_for_late;
        let _ = tx_for_late
            .send(StreamEvent::BackgroundAgentCompleted)
            .await;
    });
    let upstream_text = format!(
        "Async agent launched successfully.\nagentId: {agent_id} (internal ID - do not mention to user. The agent is working in the background. You will be notified automatically when it completes.)\n\nDo not call TaskOutput or any other tool to check status — wait for the completion notification.",
    );
    Ok(serde_json::json!({
        "status": "backgrounded",
        "task_id": tool_call_id,
        "tool_use_id": tool_call_id,
        "agent_id": agent_id,
        "subagent_type": subagent_type,
        "description": description,
        "content": [{
            "type": "text",
            "text": upstream_text,
        }],
    }))
}

async fn ask_user_question_async(
    args: &Value,
    tx: &mpsc::Sender<StreamEvent>,
) -> std::result::Result<Value, ToolError> {
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("`question` is required".into()))?
        .to_string();
    let hint = args.get("hint").and_then(|v| v.as_str()).map(str::to_string);
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if tx
        .send(StreamEvent::AskUserQuestion {
            question,
            hint,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return Err(ToolError::InvalidArgs(
            "user interface gone — AskUserQuestion aborted".into(),
        ));
    }
    let answer = reply_rx
        .await
        .map_err(|_| ToolError::InvalidArgs("AskUserQuestion cancelled".into()))?;
    Ok(serde_json::json!({
        "answer": answer,
        "declined": answer.is_empty(),
    }))
}

fn overlay_session_allowlist(settings: &mut Settings, session: &RuntimePermissionGrants) {
    use crate::config::settings::{PermissionRule, PermissionsConfig};
    use crate::permissions::{matcher, MatcherTool};
    let rules = session.snapshot();
    if rules.is_empty() {
        return;
    }
    let mut existing = settings.permissions.take().unwrap_or_else(PermissionsConfig::default);
    for raw in rules {
        let parsed = match matcher::parse(&raw) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let tool_name = match parsed.tool {
            MatcherTool::Any => "*".to_string(),
            MatcherTool::Named(n) => n,
        };
        let rule = PermissionRule {
            tool_name: Some(tool_name),
            match_pattern: parsed.pattern.clone(),
            extra: Default::default(),
        };
        existing.allow.push(rule);
    }
    settings.permissions = Some(existing);
}

fn preview_args_for_prompt(tool_name: &str, args: &Value) -> String {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    if tool_name == "Bash" {
        if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
            return truncate_preview(cmd, 200);
        }
    }
    for key in ["file_path", "path", "command", "description", "query", "url"] {
        if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
            return truncate_preview(v, 200);
        }
    }
    truncate_preview(&serde_json::to_string(args).unwrap_or_default(), 200)
}

fn truncate_preview(s: &str, cap: usize) -> String {
    let collapsed = s.replace('\n', " ");
    if collapsed.chars().count() <= cap {
        collapsed
    } else {
        let mut out: String = collapsed.chars().take(cap).collect();
        out.push('…');
        out
    }
}

fn format_err(e: &Error) -> String {
    let mut s = e.to_string();
    s = s.replace('\n', " ");
    s
}

#[cfg(test)]
mod panic_regression_tests {
    
    use tokio::sync::watch;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn select_capture_pattern_does_not_double_poll_join_handle() {
        let (_tx, mut cancel_rx) = watch::channel(false);

        let mut join = tokio::task::spawn_blocking(|| 42_i32);

        let completion: Option<std::result::Result<i32, tokio::task::JoinError>> = tokio::select! {
            biased;
            _ = cancel_rx.changed() => None,
            result = &mut join => Some(result),
        };

        let value = completion
            .expect("join branch must win when no cancel signal fired")
            .expect("spawn_blocking future must not fail");
        assert_eq!(value, 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_branch_leaves_join_handle_pollable_by_detached_task() {
        let (tx, mut cancel_rx) = watch::channel(false);

        let mut join = tokio::task::spawn_blocking(|| {
            
            std::thread::sleep(std::time::Duration::from_millis(50));
            "late-result"
        });

        let _ = tx.send(true);

        let completion: Option<std::result::Result<&str, tokio::task::JoinError>> = tokio::select! {
            biased;
            _ = cancel_rx.changed() => None,
            result = &mut join => Some(result),
        };

        assert!(completion.is_none(), "cancel branch must win when signal fires first");

        let late = join.await.expect("detached join must still succeed");
        assert_eq!(late, "late-result");
    }
}
