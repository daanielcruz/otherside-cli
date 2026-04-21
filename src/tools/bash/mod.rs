

use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::tools::ToolError;

pub mod matcher;
pub mod registry;
pub mod sync;
pub mod truncate;

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;

pub const MAX_TIMEOUT_MS: u64 = 600_000;

pub const OUTPUT_CAP: usize = 30_000;

pub const GRACE_PERIOD_MS: u64 = 2_000;

pub fn shell_registry() -> &'static registry::ShellRegistry {
    static REG: OnceLock<registry::ShellRegistry> = OnceLock::new();
    REG.get_or_init(|| registry::ShellRegistry::new(registry::MAX_CONCURRENT))
}

pub fn bash(args: &Value) -> Result<Value, ToolError> {
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

    let handle = tokio::runtime::Handle::try_current().map_err(|_| {
        ToolError::InvalidArgs("Bash tool requires an active tokio runtime".into())
    })?;
    let command_owned = command.to_string();
    let out = tokio::task::block_in_place(|| {
        handle.block_on(async move { sync::run(&command_owned, timeout_ms).await })
    })
    .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;

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
            end += line.len() + 1;
        } else {
            break;
        }
    }
    s.get(end..).unwrap_or(s)
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
