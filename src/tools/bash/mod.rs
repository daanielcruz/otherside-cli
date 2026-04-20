//! Bash / BashOutput / KillBash — shell-command tool trio.
//!
//! # Components
//!
//! - [`truncate`] — size-cap + head/tail split for oversized output.
//! - [`matcher`] — permission-rule DSL (`Bash(prefix:*)`) evaluation.
//! - [`sync`] — blocking `tokio::process::Command` driver with timeout
//!   + grace-period SIGTERM → SIGKILL.
//! - [`registry`] — async background shells keyed by [`ShellId`] with
//!   stdout/stderr accumulation and cursor-based polling.
//!
//! # Dispatch entry points
//!
//! The agent loop calls `dispatch_bash`, `dispatch_bash_output`, and
//! `dispatch_kill_bash` via `tools::mod::dispatch`. Each accepts a
//! JSON args value, validates shape, and returns a `Value` payload
//! for the model.
//!
//! Defaults (per upstream):
//! - timeout default 120 000 ms (2 min), max 600 000 ms (10 min)
//! - output cap 30 000 chars
//! - grace period on timeout 2 s
//! - background registry cap 10 concurrent shells

use std::sync::OnceLock;

use serde_json::{json, Value};

use super::ToolError;

pub mod matcher;
pub mod registry;
pub mod sync;
pub mod truncate;

/// Default per-call timeout in milliseconds (matches upstream).
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// Hard ceiling on a caller-supplied timeout.
pub const MAX_TIMEOUT_MS: u64 = 600_000;

/// Maximum chars preserved in the returned output. Upstream's cap.
pub const OUTPUT_CAP: usize = 30_000;

/// Grace period between SIGTERM and SIGKILL when a timeout fires.
pub const GRACE_PERIOD_MS: u64 = 2_000;

/// Global background shell registry — one per process. Accessed via
/// `shell_registry()`. Tests that need isolation use their own
/// [`registry::ShellRegistry`] instances instead.
pub fn shell_registry() -> &'static registry::ShellRegistry {
    static REG: OnceLock<registry::ShellRegistry> = OnceLock::new();
    REG.get_or_init(|| registry::ShellRegistry::new(registry::MAX_CONCURRENT))
}

/// Dispatch entry — synchronous-feeling wrapper so the generic
/// `tools::dispatch` can route to Bash without knowing about async.
///
/// Spawning + polling is async internally; this wrapper blocks the
/// caller only for sync mode. Background mode returns immediately
/// with the assigned shell_id.
pub fn dispatch_bash(args: &Value) -> Result<Value, ToolError> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("missing or non-string `command`".into()))?;

    let run_in_background = args
        .get("run_in_background")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let timeout_ms = match args.get("timeout") {
        None => DEFAULT_TIMEOUT_MS,
        Some(v) => {
            let n = v
                .as_u64()
                .or_else(|| v.as_f64().map(|f| f as u64))
                .ok_or_else(|| ToolError::InvalidArgs("`timeout` must be a number".into()))?;
            if n > MAX_TIMEOUT_MS {
                return Err(ToolError::InvalidArgs(format!(
                    "`timeout` exceeds {MAX_TIMEOUT_MS}ms"
                )));
            }
            n
        }
    };

    if run_in_background {
        let id = shell_registry()
            .spawn(command)
            .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        return Ok(json!({
            "status": "background",
            "shell_id": id.as_str(),
            "command": command,
        }));
    }

    // `dispatch` is called from the TUI's agent loop task, which is
    // running *inside* the tokio runtime — calling `Handle::block_on`
    // from a runtime thread panics. Use `block_in_place` so the
    // runtime knows to move other work off this thread while we
    // await, then `Handle::block_on` is safe.
    let handle = tokio::runtime::Handle::try_current().map_err(|_| {
        ToolError::InvalidArgs("Bash tool requires an active tokio runtime".into())
    })?;
    let command_owned = command.to_string();
    let out = tokio::task::block_in_place(|| {
        handle.block_on(async move { sync::run(&command_owned, timeout_ms).await })
    })
    .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;

    // Upstream's `mapToolResultToToolResultBlockParam` emits the wire
    // tool_result.content as a single string merging stdout + stderr
    // with a newline separator (see reference BashTool.tsx line ~630:
    // `content: [processedStdout, errorMessage, backgroundInfo]
    // .filter(Boolean).join('\n')`). Match that shape on `content` so
    // the model sees the same raw terminal output it was trained on;
    // keep the split `stdout` / `stderr` fields alongside for the
    // renderer + permission layer that want them separately.
    let content = merge_stdout_stderr(&out.stdout, &out.stderr);
    Ok(json!({
        "status": if out.timed_out { "timeout" } else { "ok" },
        "exit_code": out.exit_code,
        "content": content,
        "stdout": out.stdout,
        "stderr": out.stderr,
        "stdout_truncated": out.stdout_truncated,
        "stderr_truncated": out.stderr_truncated,
        "was_truncated": out.was_truncated(),
        "elapsed_ms": out.elapsed_ms,
    }))
}

/// Combine stdout and stderr the way upstream's tool-result packer
/// does: trim stdout of leading whitespace-only lines + trailing
/// whitespace, trim stderr, then join with a newline only when both
/// are non-empty. Keeps the format the model was trained on.
fn merge_stdout_stderr(stdout: &str, stderr: &str) -> String {
    let processed_stdout = trim_leading_blank_lines(stdout).trim_end().to_string();
    let stderr_trimmed = stderr.trim();
    match (processed_stdout.is_empty(), stderr_trimmed.is_empty()) {
        (false, false) => format!("{processed_stdout}\n{stderr_trimmed}"),
        (false, true) => processed_stdout,
        (true, false) => stderr_trimmed.to_string(),
        (true, true) => String::new(),
    }
}

fn trim_leading_blank_lines(s: &str) -> &str {
    let mut end = 0usize;
    for line in s.lines() {
        if line.trim().is_empty() {
            end += line.len() + 1; // +1 for \n
        } else {
            break;
        }
    }
    s.get(end..).unwrap_or(s)
}

/// Dispatch — `BashOutput`. Polls the background registry for new
/// output on a given shell id.
pub fn dispatch_bash_output(args: &Value) -> Result<Value, ToolError> {
    let bash_id = args
        .get("bash_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("missing or non-string `bash_id`".into()))?;
    let filter = args.get("filter").and_then(Value::as_str);
    let poll = shell_registry()
        .poll(bash_id, filter)
        .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
    Ok(json!({
        "shell_id": bash_id,
        "status": poll.status.as_str(),
        "exit_code": poll.exit_code,
        "stdout": poll.stdout,
        "stderr": poll.stderr,
    }))
}

/// Dispatch — `KillBash`. SIGTERM → grace → SIGKILL, then reap.
pub fn dispatch_kill_bash(args: &Value) -> Result<Value, ToolError> {
    let shell_id = args
        .get("shell_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("missing or non-string `shell_id`".into()))?;
    shell_registry()
        .kill(shell_id)
        .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
    Ok(json!({
        "shell_id": shell_id,
        "status": "killed",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_stdout_only_when_stderr_empty() {
        let merged = merge_stdout_stderr("hello\n", "");
        assert_eq!(merged, "hello");
    }

    #[test]
    fn merge_keeps_stderr_only_when_stdout_empty() {
        let merged = merge_stdout_stderr("", "boom\n");
        assert_eq!(merged, "boom");
    }

    #[test]
    fn merge_joins_both_with_newline() {
        let merged = merge_stdout_stderr("hello\n", "warning\n");
        assert_eq!(merged, "hello\nwarning");
    }

    #[test]
    fn merge_trims_leading_blank_lines_from_stdout() {
        let merged = merge_stdout_stderr("\n\n   \nreal output\n", "");
        assert_eq!(merged, "real output");
    }

    #[test]
    fn merge_returns_empty_when_both_empty() {
        assert_eq!(merge_stdout_stderr("", ""), "");
        assert_eq!(merge_stdout_stderr("   \n", "  "), "");
    }
}
