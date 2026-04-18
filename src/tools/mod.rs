//! Tool registry + execution surface.
//!
//! Tool schemas source from `harness::build_tools_array` (the fingerprint
//! corpus extracted in 009 and byte-matched against live capture). The
//! advertised 9-tool set is Agent / Bash / Edit / Glob / Grep / Read /
//! Skill / ToolSearch / Write (change 010 — C48 anchor selection).
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
pub mod read;
pub mod read_set;
pub mod schemas;
pub mod skill;
pub mod tool_search;
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
}
