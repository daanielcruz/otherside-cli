//! Tool registry + execution surface.
//!
//! Tool schemas source from `harness::build_tools_array` (the fingerprint
//! corpus extracted in 009 and byte-matched against live capture). The
//! advertised 9-tool set is Agent / Bash / Edit / Glob / Grep / Read /
//! Skill / ToolSearch / Write (change 010 — C48 anchor selection).
//!
//! 018 added the first wave of **deferred tools** — TaskCreate / TaskList
//! / TaskGet / TaskUpdate / NotebookEdit. Deferred tools are NOT in the
//! wire-advertised `tools[]` array; the model loads their schemas on
//! demand via `ToolSearch` (matches upstream's deferred-tools reminder
//! at `harness_corpus/system-reminders/deferred-tools.txt`). Deferred
//! dispatchers live in `tools::task` and `tools::notebook`; schemas
//! flow through `tools::schemas::deferred_schemas()`.
//!
//! # Contract
//!
//! Every tool is `fn(&Value) -> Result<Value, ToolError>`. Input is
//! accepted as-emitted by the model; per-tool validation is the tool's
//! responsibility. Schema enforcement at the dispatcher level is a
//! later pass.
//!
//! # Retired names
//!
//! `Task` → `Agent` (C48 anchor selection, 2026-04-18). `BashOutput` /
//! `KillBash` → internal helpers under `bash::` (no longer advertised;
//! background shell control now rides `Bash` via the captured
//! `run_in_background` property).

pub mod agent;
pub mod bash;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod notebook;
pub mod read;
pub mod read_set;
pub mod schemas;
pub mod skill;
pub mod task;
pub mod tool_search;
pub mod web_fetch;
pub mod write;

pub use schemas::{openai_tools, schema_for, tool_schemas, ToolSchema};

use serde_json::Value;

/// Tool execution error surface. Serializes to the ToolResult the
/// agent loop feeds back to the model.
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

/// Gated dispatch — threads the active `PermissionMode` + `Settings`
/// through [`crate::permissions::resolve`] before delegating to
/// [`dispatch`]. Mirrors upstream's `checkPermissionsAndCallTool` at
/// `services/tools/toolExecution.ts:608`.
///
/// - [`Decision::Allow`] → delegate.
/// - [`Decision::Deny`] → `PermissionDenied(rule)`.
/// - [`Decision::Ask`] → `PermissionDenied` with a "modal pending" note.
///   The interactive prompt modal is scoped for spec 007; until it
///   lands the Ask branch degrades to a clean refusal so the model
///   sees a structured error instead of a hang.
pub fn dispatch_gated(
    tool_name: &str,
    args: &Value,
    settings: &crate::config::settings::Settings,
    mode: crate::config::settings::PermissionMode,
) -> Result<Value, ToolError> {
    use crate::permissions::{resolve, Decision};
    let input_str = serde_json::to_string(args).unwrap_or_default();
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

/// Dispatch a tool call by name. The agent loop calls this after the
/// model emits a `tool_use` block.
pub fn dispatch(tool_name: &str, args: &Value) -> Result<Value, ToolError> {
    match tool_name {
        "Agent" => agent::agent(args),
        "Bash" => bash::dispatch_bash(args),
        "Edit" => edit::edit(args),
        "Glob" => glob::glob(args),
        "Grep" => grep::grep(args),
        "Read" => read::read(args),
        "Skill" => skill::skill(args),
        "ToolSearch" => tool_search::tool_search(args),
        "Write" => write::write(args),
        // Deferred tools (018 first wave). Not wire-advertised; loaded on
        // demand via ToolSearch. Dispatch works whether or not the model
        // went through the resolve step.
        "TaskCreate" => task::task_create(args),
        "TaskList" => task::task_list(args),
        "TaskGet" => task::task_get(args),
        "TaskUpdate" => task::task_update(args),
        "NotebookEdit" => notebook::notebook_edit(args),
        // 019 second wave — HTTP GET + HTML→markdown deferred tool.
        "WebFetch" => web_fetch::web_fetch(args),
        // Affordance hints for models that hallucinate retired names.
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
    fn schemas_loaded_for_all_advertised_tools() {
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
            assert!(schema_for(name).is_some(), "schema missing for `{name}`");
        }
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
    fn retired_killbash_dispatch_returns_unsupported() {
        let err = dispatch("KillBash", &json!({})).unwrap_err();
        assert!(matches!(err, ToolError::Unsupported(_)));
    }

    #[test]
    fn dispatcher_covers_all_advertised() {
        // Each advertised name must NOT return Unsupported.
        // Tools may error on missing args or other validation — that's fine.
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
                _ => {} // Any other result (Ok or other Err) is fine.
            }
        }
    }

    #[test]
    fn dispatcher_covers_deferred_first_wave() {
        // 018 deferred tools MUST route through to their dispatchers, not
        // bounce off the default Unsupported arm. Empty args are fine —
        // per-tool validation handles missing fields.
        for name in ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "NotebookEdit"] {
            let res = dispatch(name, &json!({}));
            match res {
                Err(ToolError::Unsupported(_)) => {
                    panic!("deferred tool `{name}` returned Unsupported")
                }
                _ => {}
            }
        }
    }

    #[test]
    fn dispatcher_covers_web_fetch() {
        // 019 WebFetch deferred tool. Empty args hit InvalidArgs (url
        // missing) — the invariant is that the arm routes, not that it
        // succeeds without inputs.
        let res = dispatch("WebFetch", &json!({}));
        match res {
            Err(ToolError::Unsupported(_)) => {
                panic!("deferred tool `WebFetch` returned Unsupported")
            }
            _ => {}
        }
    }

    mod gated {
        use super::*;
        use crate::config::settings::{PermissionMode, Settings};

        #[test]
        fn yolo_short_circuits_deny_rules() {
            // Deny rule present but Yolo outranks everything.
            let mut s = Settings::default();
            s.permissions = Some(crate::config::settings::PermissionsConfig {
                deny: vec![crate::config::settings::PermissionRule {
                    tool_name: Some("*".into()),
                    match_pattern: None,
                    extra: Default::default(),
                }],
                ..Default::default()
            });
            // Bash with a runnable command — just exercise the gate, not the
            // dispatcher's output path.
            let res = dispatch_gated(
                "Glob",
                &json!({"pattern": "*.md"}),
                &s,
                PermissionMode::Yolo,
            );
            // Allow reached — Glob runs and returns Ok (empty or populated).
            assert!(res.is_ok(), "Yolo should bypass deny rule, got {res:?}");
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
            // Read without args → InvalidArgs, but NOT PermissionDenied —
            // gate allowed, dispatcher validated.
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
            // No rules configured → resolve returns Ask{None} →
            // dispatch_gated maps to PermissionDenied with the
            // modal-pending note.
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
            // Edit/Write should pass the gate; dispatcher will then hit
            // InvalidArgs on empty input — that's the expected non-gate
            // outcome.
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
}
