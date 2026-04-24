
pub mod agent;
pub mod ask_user_question;
pub mod background_signal;
pub mod bash;
pub mod cron;
pub mod deferred_registry;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod http;
pub mod notebook;
pub mod plan_mode;
pub mod read;
pub mod schemas;
pub mod send_message;
pub mod skill;
pub mod task;
pub mod tool_search;
pub mod web_fetch;
pub mod web_search;
pub mod worktree;
pub mod write;

pub use schemas::{openai_tools, schema_for, tool_schemas, ToolSchema};
pub use read::set as read_set;

use serde_json::Value;

thread_local! {

    static CURRENT_TOOL_CALL_ID: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };

    static CURRENT_PROVIDER: std::cell::RefCell<Option<crate::config::providers::ProviderId>> =
        const { std::cell::RefCell::new(None) };
}

pub fn with_tool_call_id<R>(tool_call_id: String, f: impl FnOnce() -> R) -> R {
    CURRENT_TOOL_CALL_ID.with(|cell| {
        let prev = cell.borrow_mut().replace(tool_call_id);
        let out = f();
        *cell.borrow_mut() = prev;
        out
    })
}

pub fn current_tool_call_id() -> Option<String> {
    CURRENT_TOOL_CALL_ID.with(|cell| cell.borrow().clone())
}

pub fn with_current_provider<R>(
    provider: crate::config::providers::ProviderId,
    f: impl FnOnce() -> R,
) -> R {
    CURRENT_PROVIDER.with(|cell| {
        let prev = cell.borrow_mut().replace(provider);
        let out = f();
        *cell.borrow_mut() = prev;
        out
    })
}

pub fn current_provider() -> crate::config::providers::ProviderId {
    CURRENT_PROVIDER.with(|cell| cell.borrow().clone())
        .unwrap_or(crate::config::providers::ProviderId::ClaudeCode)
}

pub fn is_hidden_tool(name: &str) -> bool {
    matches!(
        name,
        "ToolSearch"
            | "TaskCreate"
            | "TaskGet"
            | "TaskList"
            | "TaskOutput"
            | "TaskStop"
            | "TaskUpdate"
    )
}

pub fn effective_cwd() -> std::path::PathBuf {
    crate::tools::worktree::effective_cwd()
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        })
}

pub fn resolve_against_cwd(path: &std::path::Path) -> std::path::PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        effective_cwd().join(path)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("glob pattern error: {0}")]
    GlobPattern(String),
    #[error("regex pattern error: {0}")]
    RegexPattern(String),
    #[error("tool not supported: {0}")]
    Unsupported(String),
}

pub fn dispatch_gated(
    tool_name: &str,
    args: &Value,
    settings: &crate::config::settings::Settings,
    mode: crate::config::settings::PermissionMode,
) -> Result<Value, ToolError> {
    use crate::permissions::{resolve, Decision};
    let input_str = matcher_input_for(tool_name, args);
    match resolve(tool_name, &input_str, settings, mode) {
        Decision::Allow => dispatch(tool_name, args),
        Decision::Deny { rule } => Err(ToolError::PermissionDenied(rule)),
        Decision::Ask { rule } => {
            let suffix = rule
                .map(|r| format!(" (rule: {r})"))
                .unwrap_or_default();
            Err(ToolError::PermissionDenied(format!(
                "interactive approval required{suffix} — prompt modal pending spec 007"
            )))
        }
    }
}

pub fn matcher_input_for(tool_name: &str, args: &Value) -> String {
    let field = |name: &str| {
        args.get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    match tool_name {
        "Bash" => {
            if let Some(cmd) = field("command") {
                return cmd;
            }
        }
        "Edit" | "Write" | "Read" => {
            if let Some(path) = field("file_path") {
                return path;
            }
        }
        "NotebookEdit" => {
            if let Some(path) = field("notebook_path") {
                return path;
            }
        }
        "Glob" | "Grep" => {
            if let Some(pattern) = field("pattern") {
                return pattern;
            }
            if let Some(path) = field("path") {
                return path;
            }
        }
        "WebFetch" => {
            if let Some(url) = field("url") {
                return url;
            }
        }
        "WebSearch" | "ToolSearch" => {
            if let Some(query) = field("query") {
                return query;
            }
        }
        "Agent" => {
            if let Some(subagent_type) = field("subagent_type") {
                return subagent_type;
            }
        }
        "Skill" => {
            if let Some(name) = field("name") {
                return name;
            }
        }
        _ => {}
    }
    serde_json::to_string(args).unwrap_or_default()
}

pub fn dispatch(tool_name: &str, args: &Value) -> Result<Value, ToolError> {
    match tool_name {
        "Agent" => agent::agent(args),
        "Bash" => bash::bash(args),
        "Edit" => edit::edit(args),
        "Glob" => glob::glob(args),
        "Grep" => grep::grep(args),
        "Read" => read::read(args),
        "Skill" => skill::skill(args),
        "ToolSearch" => tool_search::tool_search(args),
        "Write" => write::write(args),

        "TaskCreate" => task::task_create(args),
        "TaskList" => task::task_list(args),
        "TaskGet" => task::task_get(args),
        "TaskUpdate" => task::task_update(args),
        "NotebookEdit" => notebook::notebook_edit(args),

        "WebFetch" => web_fetch::web_fetch(args),

        "WebSearch" => web_search::dispatch(args, current_provider()),

        "EnterPlanMode" => plan_mode::enter_plan_mode(args),
        "ExitPlanMode" => plan_mode::exit_plan_mode(args),
        "EnterWorktree" => worktree::enter_worktree(args),
        "ExitWorktree" => worktree::exit_worktree(args),
        "TaskOutput" => task::task_output(args),
        "TaskStop" => task::task_stop(args),
        "CronCreate" => cron::cron_create(args),
        "CronDelete" => cron::cron_delete(args),
        "CronList" => cron::cron_list(args),
        "ScheduleWakeup" => cron::schedule_wakeup(args),

        "AskUserQuestion" => Err(ToolError::Unsupported(
            "AskUserQuestion must be handled on the async TUI dispatch path (pending_question broker) — synchronous dispatch cannot block for the user. Route through the broker or fall back to a plain Bash/Read prompt."
                .into(),
        )),

        "SendMessage" => send_message::dispatch(args),

        "Task" => Err(ToolError::Unsupported(
            "tool `Task` is retired; use `Agent` for subagent dispatch (010 anchor selection)"
                .to_string(),
        )),
        "BashOutput" => Err(ToolError::Unsupported(
            "tool `BashOutput` is no longer advertised; background shell output is delivered inline through `Bash` with `run_in_background: true`".to_string(),
        )),
        "KillBash" => Err(ToolError::Unsupported(
            "tool `KillBash` is no longer advertised; backgrounded shells are managed inside `Bash`".to_string(),
        )),
        other => Err(ToolError::Unsupported(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dispatch_unknown_tool_errors() {
        let err = dispatch("NotARealTool", &json!({})).unwrap_err();
        assert!(matches!(err, ToolError::Unsupported(_)));
    }

    #[test]
    fn retired_task_dispatch_returns_unsupported_with_hint() {
        let err = dispatch("Task", &json!({})).unwrap_err();
        match err {
            ToolError::Unsupported(msg) => {
                assert!(msg.contains("retired"));
                assert!(msg.contains("Agent"));
            }
            _ => panic!("expected Unsupported"),
        }
    }

    #[test]
    fn retired_bashoutput_dispatch_returns_unsupported_with_hint() {
        let err = dispatch("BashOutput", &json!({})).unwrap_err();
        match err {
            ToolError::Unsupported(msg) => {
                assert!(msg.contains("run_in_background"));
            }
            _ => panic!("expected Unsupported"),
        }
    }

    #[test]
    fn dispatcher_covers_all_advertised() {

        for name in [
            "Agent",
            "Bash",
            "Edit",
            "Glob",
            "Grep",
            "Read",
            "Skill",
            "ToolSearch",
            "Write",
        ] {
            let res = dispatch(name, &json!({}));
            match res {
                Err(ToolError::Unsupported(_)) => {
                    panic!("advertised tool `{name}` returned Unsupported")
                }
                _ => {}
            }
        }
    }

    #[test]
    fn dispatcher_covers_deferred_tools() {
        for name in [
            "TaskCreate", "TaskList", "TaskGet", "TaskUpdate",
            "NotebookEdit", "WebFetch", "WebSearch",
        ] {
            let res = dispatch(name, &json!({}));
            if let Err(ToolError::Unsupported(_)) = res {
                panic!("deferred tool `{name}` returned Unsupported")
            }
        }
    }

    mod gated {
        use super::*;
        use crate::config::settings::{PermissionMode, Settings};

        #[test]
        fn yolo_respects_deny_rules() {

            let mut s = Settings::default();
            s.permissions = Some(crate::config::settings::PermissionsConfig {
                deny: vec![crate::config::settings::PermissionRule {
                    tool_name: Some("*".into()),
                    match_pattern: None,
                    extra: Default::default(),
                }],
                ..Default::default()
            });

            let res = dispatch_gated(
                "Glob",
                &json!({"pattern": "*.md"}),
                &s,
                PermissionMode::Yolo,
            );

            assert!(
                matches!(res, Err(ToolError::PermissionDenied(_))),
                "Yolo must honor explicit deny rules, got {res:?}"
            );
        }

        #[test]
        fn file_permission_rules_match_paths_not_json() {
            let mut s = Settings::default();
            s.permissions = Some(crate::config::settings::PermissionsConfig {
                deny: vec![crate::config::settings::PermissionRule {
                    tool_name: Some("Write".into()),
                    match_pattern: Some("**/credentials.json".into()),
                    extra: Default::default(),
                }],
                ..Default::default()
            });

            let res = dispatch_gated(
                "Write",
                &json!({"file_path": "/repo/app/credentials.json", "content": "{}"}),
                &s,
                PermissionMode::Yolo,
            );

            assert!(
                matches!(res, Err(ToolError::PermissionDenied(_))),
                "file deny pattern must apply to file_path, got {res:?}"
            );
        }

        #[test]
        fn plan_mode_blocks_mutating_tools() {
            let s = Settings::default();
            for tool in ["Edit", "Write", "Bash"] {
                let res = dispatch_gated(tool, &json!({}), &s, PermissionMode::Plan);
                match res {
                    Err(ToolError::PermissionDenied(msg)) => {
                        assert!(
                            msg.contains("plan"),
                            "plan-mode deny rule message missing 'plan': {msg}"
                        );
                    }
                    other => panic!("plan mode must deny `{tool}`, got {other:?}"),
                }
            }
        }

        #[test]
        fn plan_mode_allows_read_tools() {
            let s = Settings::default();

            let res = dispatch_gated("Read", &json!({}), &s, PermissionMode::Plan);
            match res {
                Err(ToolError::PermissionDenied(_)) => {
                    panic!("plan mode denied a read-only tool")
                }
                _ => {}
            }
        }

        #[test]
        fn default_mode_asks_without_rule_maps_to_denied() {
            let s = Settings::default();

            let res = dispatch_gated(
                "Bash",
                &json!({"command": "ls"}),
                &s,
                PermissionMode::Default,
            );
            match res {
                Err(ToolError::PermissionDenied(msg)) => {
                    assert!(
                        msg.contains("interactive approval"),
                        "default-mode Ask must surface modal-pending note: {msg}"
                    );
                }
                other => panic!("expected PermissionDenied, got {other:?}"),
            }
        }

        #[test]
        fn accept_edits_mode_allows_edit_and_write() {
            let s = Settings::default();

            for tool in ["Edit", "Write"] {
                let res = dispatch_gated(tool, &json!({}), &s, PermissionMode::AcceptEdits);
                match res {
                    Err(ToolError::PermissionDenied(_)) => {
                        panic!("accept-edits must allow `{tool}`")
                    }
                    _ => {}
                }
            }
        }

        #[test]
        fn accept_edits_mode_still_asks_on_bash() {
            let s = Settings::default();
            let res = dispatch_gated(
                "Bash",
                &json!({"command": "ls"}),
                &s,
                PermissionMode::AcceptEdits,
            );
            match res {
                Err(ToolError::PermissionDenied(msg)) => {
                    assert!(msg.contains("interactive approval"));
                }
                other => panic!("accept-edits must still gate Bash, got {other:?}"),
            }
        }
    }

    mod provider_scope {
        use super::*;
        use crate::config::providers::ProviderId;

        #[test]
        fn current_provider_defaults_to_claude_code() {
            assert_eq!(current_provider(), ProviderId::ClaudeCode);
        }

        #[test]
        fn with_current_provider_scopes_value() {
            let seen = with_current_provider(ProviderId::Codex, || current_provider());
            assert_eq!(seen, ProviderId::Codex);
            assert_eq!(current_provider(), ProviderId::ClaudeCode,
                "provider must reset after scope");
        }

        #[test]
        fn with_current_provider_nests_correctly() {
            let seen = with_current_provider(ProviderId::Codex, || {
                with_current_provider(ProviderId::GeminiCli, || current_provider())
            });
            assert_eq!(seen, ProviderId::GeminiCli);
            assert_eq!(current_provider(), ProviderId::ClaudeCode);
        }
    }
}
