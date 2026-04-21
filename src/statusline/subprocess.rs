

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use super::types::{StatuslineCtx, StatuslineError};

const DEFAULT_TIMEOUT: Duration = Duration::from_millis(1500);

const MAX_STDOUT_BYTES: usize = 4096;

const POLL_INTERVAL: Duration = Duration::from_millis(10);

pub fn execute(command: &str, ctx: &StatuslineCtx) -> Result<String, StatuslineError> {
    execute_with_timeout(command, ctx, DEFAULT_TIMEOUT)
}

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

        let _ = stdin.write_all(&payload);

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

        let parsed: serde_json::Value = serde_json::from_str(&captured).unwrap();
        assert_eq!(parsed["session_id"].as_str(), Some("test-session"));
        std::fs::remove_file(&tap).ok();
    }
}

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
