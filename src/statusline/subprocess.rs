//! Subprocess mode: pipe the statusline payload as JSON on stdin to
//! a user-configured shell command, read the first line of stdout.
//!
//! # Timeout + runtime
//!
//! C50 initially picked `tokio::time::timeout` wrapping
//! `tokio::process::Command`. On implementation, a simpler
//! `std::process::Command` + `Child::try_wait` poll loop is enough —
//! zero extra deps, no runtime nesting, render path can call from
//! any context (TUI event loop OR serve request handler). The
//! semantics are the same: bounded wall-clock, SIGKILL on
//! expiration. Updated decision recorded inline; the architectural
//! outcome (no `wait-timeout` crate) holds.
//!
//! # Working directory
//!
//! The child inherits the parent's CWD (matches the upstream
//! contract so `jq` pipelines that rely on `$PWD` see the right dir).
//! We do NOT fall back to `workspace.project_dir`.
//!
//! # Stdin / stdout
//!
//! Payload serialized via `serde_json::to_vec` with `preserve_order`
//! (already enabled repo-wide per R-56 / C49). Stdout capped at
//! `MAX_STDOUT_BYTES` to bound memory. Only the first non-empty line
//! is returned.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use super::types::{StatuslineCtx, StatuslineError};

/// Hard cap on subprocess runtime before SIGKILL.
const DEFAULT_TIMEOUT: Duration = Duration::from_millis(1500);

/// Max bytes we read from stdout. 4 KB is plenty for a one-line
/// status; anything longer gets truncated + the first line returned.
const MAX_STDOUT_BYTES: usize = 4096;

/// Poll interval for `try_wait`. Low enough that a 50ms command feels
/// instantaneous, high enough to avoid pegging a core.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Run `sh -c <command>` with the payload on stdin, return the first
/// non-empty line of stdout. Times out at `DEFAULT_TIMEOUT`.
pub fn execute(command: &str, ctx: &StatuslineCtx) -> Result<String, StatuslineError> {
    execute_with_timeout(command, ctx, DEFAULT_TIMEOUT)
}

/// Testable variant with explicit timeout — unit tests use short
/// timeouts to exercise the killed-child path.
pub fn execute_with_timeout(
    command: &str,
    ctx: &StatuslineCtx,
    timeout: Duration,
) -> Result<String, StatuslineError> {
    let payload = serde_json::to_vec(&ctx.payload)?;

    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(StatuslineError::SpawnFailed)?;

    if let Some(mut stdin) = child.stdin.take() {
        // Best-effort write + close. If the command doesn't read stdin,
        // write_all may EPIPE — that's fine, the child already decided
        // to ignore our payload.
        let _ = stdin.write_all(&payload);
        // Drop stdin here to send EOF to the child.
    }

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_bounded(child.stdout.take())?;
                if !status.success() {
                    return Err(StatuslineError::NonZeroExit {
                        code: status.code().unwrap_or(-1),
                    });
                }
                return first_line(&stdout);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(StatuslineError::Timeout);
                }
                sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(StatuslineError::SpawnFailed(e)),
        }
    }
}

fn read_bounded(stdout: Option<std::process::ChildStdout>) -> Result<String, StatuslineError> {
    let Some(mut reader) = stdout else {
        return Ok(String::new());
    };
    let mut buf = Vec::with_capacity(MAX_STDOUT_BYTES);
    let mut chunk = [0u8; 512];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let remaining = MAX_STDOUT_BYTES.saturating_sub(buf.len());
                if remaining == 0 {
                    break;
                }
                let take = n.min(remaining);
                buf.extend_from_slice(&chunk[..take]);
                if buf.len() >= MAX_STDOUT_BYTES {
                    break;
                }
            }
            Err(_) => return Err(StatuslineError::OutputNotUtf8),
        }
    }
    String::from_utf8(buf).map_err(|_| StatuslineError::OutputNotUtf8)
}

fn first_line(stdout: &str) -> Result<String, StatuslineError> {
    let line = stdout
        .lines()
        .map(str::trim_end)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.is_empty() {
        Err(StatuslineError::EmptyOutput)
    } else {
        Ok(line.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::statusline::types::StatuslineCtx;

    #[test]
    fn echo_returns_single_line() {
        let ctx = StatuslineCtx::minimal_for_test();
        let out = execute("echo hello", &ctx).unwrap();
        assert_eq!(out, "hello");
    }

    #[test]
    fn multi_line_returns_first_nonempty() {
        let ctx = StatuslineCtx::minimal_for_test();
        let out = execute("printf '\\n\\none\\ntwo\\n'", &ctx).unwrap();
        assert_eq!(out, "one");
    }

    #[test]
    fn nonzero_exit_surfaces_error() {
        let ctx = StatuslineCtx::minimal_for_test();
        let err = execute("false", &ctx).unwrap_err();
        assert!(matches!(err, StatuslineError::NonZeroExit { code: 1 }));
    }

    #[test]
    fn timeout_kills_slow_child() {
        let ctx = StatuslineCtx::minimal_for_test();
        let err = execute_with_timeout("sleep 5", &ctx, Duration::from_millis(200)).unwrap_err();
        assert!(matches!(err, StatuslineError::Timeout));
    }

    #[test]
    fn empty_output_surfaces_error() {
        let ctx = StatuslineCtx::minimal_for_test();
        let err = execute("true", &ctx).unwrap_err();
        assert!(matches!(err, StatuslineError::EmptyOutput));
    }

    #[test]
    fn ansi_escapes_preserved_through_stdout() {
        let ctx = StatuslineCtx::minimal_for_test();
        let out = execute("printf '\\033[31mred\\033[0m\\n'", &ctx).unwrap();
        assert!(out.contains("\x1b[31m"));
        assert!(out.contains("red"));
    }

    #[test]
    fn stdin_receives_json_payload() {
        let ctx = StatuslineCtx::minimal_for_test();
        let tap = std::env::temp_dir().join(format!(
            "otherside-statusline-tap-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tap);
        let script = format!(
            "cat > {} && echo ok",
            shell_quote::quote(tap.to_str().unwrap())
        );
        let out = execute(&script, &ctx).unwrap();
        assert_eq!(out, "ok");
        let captured = std::fs::read_to_string(&tap).unwrap();
        // The JSON payload landed on stdin and got tee'd to the tempfile.
        let parsed: serde_json::Value = serde_json::from_str(&captured).unwrap();
        assert_eq!(parsed["session_id"].as_str(), Some("test-session"));
        std::fs::remove_file(&tap).ok();
    }
}

// A tiny shell-quoter for the stdin-capture test above.
// Keeps the crate free of a shell-escaping dep for a single test usage.
#[cfg(test)]
mod shell_quote {
    pub fn quote(s: &str) -> String {
        if s.chars().all(|c| c.is_alphanumeric() || c == '/' || c == '-' || c == '_' || c == '.') {
            s.to_string()
        } else {
            let escaped = s.replace('\'', "'\\''");
            format!("'{escaped}'")
        }
    }
}
