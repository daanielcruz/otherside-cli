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
    fn on_tool_start(&self, name: &str, args_preview: &str) {
        let _ = self.tx.try_send(StreamEvent::NestedToolStart {
            name: name.to_string(),
            args_preview: args_preview.to_string(),
        });
    }

    fn on_tool_finish(&self, success: bool, elapsed_ms: u64) {
        let _ = self.tx.try_send(StreamEvent::NestedToolFinish {
            success,
            elapsed_ms,
        });
    }
}

pub(super) struct TuiDispatcher {
    pub tx: mpsc::Sender<StreamEvent>,
    pub settings: Arc<Settings>,
    pub mode: PermissionMode,
    pub session_allowlist: RuntimePermissionGrants,
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
) -> std::result::Result<Value, ToolError> {
    if tool_name == "AskUserQuestion" {
        return ask_user_question_async(args, tx).await;
    }

    let input_str = tools::matcher_input_for(tool_name, args);

    let mut composed = settings.clone();
    overlay_session_allowlist(&mut composed, session_allowlist);

    let dispatch_scoped = |tool_name: &str, args: &Value| {
        if tool_name == "Agent" {
            let emitter: Arc<dyn NestedEmitter> =
                Arc::new(StreamEmitter { tx: tx.clone() });
            crate::agent::subagents::with_nested_emitter(emitter, || {
                tools::with_tool_call_id(tool_call_id.to_string(), || {
                    tools::dispatch(tool_name, args)
                })
            })
        } else {
            tools::with_tool_call_id(tool_call_id.to_string(), || tools::dispatch(tool_name, args))
        }
    };
    match permissions::resolve(tool_name, &input_str, &composed, mode) {
        Decision::Allow => dispatch_scoped(tool_name, args),
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
                Ok(PermissionResponse::Allow) => dispatch_scoped(tool_name, args),
                Ok(PermissionResponse::AllowSession) => dispatch_scoped(tool_name, args),
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
