

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::tools::ToolError;

fn stack() -> &'static Mutex<Vec<PathBuf>> {
    static STACK: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    STACK.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn effective_cwd() -> Option<PathBuf> {
    stack().lock().ok().and_then(|s| s.last().cloned())
}

pub fn push(path: PathBuf) {
    if let Ok(mut s) = stack().lock() {
        s.push(path);
    }
}

pub fn pop() -> Option<PathBuf> {
    stack().lock().ok().and_then(|mut s| s.pop())
}

#[cfg(test)]
pub fn clear() {
    if let Ok(mut s) = stack().lock() {
        s.clear();
    }
}

pub fn enter_worktree(args: &Value) -> Result<Value, ToolError> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("`path` is required".into()))?;
    let buf = PathBuf::from(path);
    if !buf.is_absolute() {
        return Err(ToolError::InvalidArgs(format!(
            "worktree path must be absolute: {path}"
        )));
    }
    if !buf.exists() {
        return Err(ToolError::InvalidArgs(format!(
            "worktree path does not exist: {path}"
        )));
    }
    if !buf.is_dir() {
        return Err(ToolError::InvalidArgs(format!(
            "worktree path is not a directory: {path}"
        )));
    }
    push(buf.clone());
    Ok(json!({
        "ok": true,
        "cwd": buf,
        "depth": effective_cwd().map(|_| 1u64).unwrap_or(0),
    }))
}

pub fn exit_worktree(_args: &Value) -> Result<Value, ToolError> {
    match pop() {
        Some(path) => Ok(json!({
            "ok": true,
            "popped": path,
            "restored": effective_cwd(),
        })),
        None => Ok(json!({
            "ok": false,
            "error": "worktree stack is empty; nothing to exit",
        })),
    }
}

pub const TOOL_ENTER_WORKTREE_JSON: &str =
    include_str!("../../../harness_corpus/tools/EnterWorktree.json");

pub const TOOL_EXIT_WORKTREE_JSON: &str =
    include_str!("../../../harness_corpus/tools/ExitWorktree.json");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enter_worktree_requires_absolute_path() {
        let err = enter_worktree(&json!({ "path": "relative/dir" })).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn enter_worktree_rejects_missing_path() {
        let err = enter_worktree(&json!({ "path": "/nope/does/not/exist" })).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn worktree_push_pop_round_trip() {
        clear();
        let tmp = std::env::temp_dir();
        enter_worktree(&json!({ "path": tmp.to_string_lossy() })).unwrap();
        assert_eq!(effective_cwd().as_ref(), Some(&tmp));
        exit_worktree(&json!({})).unwrap();
        assert!(effective_cwd().is_none());
    }

    #[test]
    fn exit_worktree_on_empty_stack_reports_no_op() {
        clear();
        let out = exit_worktree(&json!({})).unwrap();
        assert_eq!(out["ok"], false);
    }

    #[test]
    fn schemas_parse_as_json() {
        for raw in [TOOL_ENTER_WORKTREE_JSON, TOOL_EXIT_WORKTREE_JSON] {
            let _: Value = serde_json::from_str(raw).unwrap();
        }
    }
}
