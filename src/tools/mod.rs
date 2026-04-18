//! Tool registry + execution surface.
//!
//! The model decides when to call a tool; this module is what the agent
//! loop dispatches to once that decision is made. Tool schemas live as
//! hand-transcribed JSON under `otherside-cli/tool_corpus/` and are
//! `include_str!`'d into the binary — see `tool_corpus/README.md` for
//! why that's a deliberate harness-fidelity choice.
//!
//! # Contract
//!
//! Every tool is a `fn(&Value) -> Result<Value, ToolError>`. Input is
//! validated against `input_schema` before dispatch (schema lives in
//! the corpus; enforcement is a v2 task — today we accept whatever the
//! model emits and let the tool error on malformed args).

pub mod glob;
pub mod grep;
pub mod read;
pub mod schemas;
pub mod task;

pub use schemas::{schema_for, tool_schemas, ToolSchema};

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
        "Read" => read::read(args),
        "Glob" => glob::glob(args),
        "Grep" => grep::grep(args),
        "Task" => task::task(args),
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
    fn schemas_loaded_for_all_four_tools() {
        assert!(schema_for("Read").is_some());
        assert!(schema_for("Glob").is_some());
        assert!(schema_for("Grep").is_some());
        assert!(schema_for("Task").is_some());
    }
}
