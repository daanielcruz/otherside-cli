//! Sync bash driver — spawn via `sh -c`, race against a timeout,
//! SIGTERM with grace, then SIGKILL.

use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::process::Command;
use tokio::time::timeout;

use super::{truncate, GRACE_PERIOD_MS};

/// Output of a single synchronous Bash invocation. stdout and stderr
/// are surfaced separately to match upstream `BashToolResultMessage`
/// which renders them in distinct styles (dim for stdout, error-red
/// for stderr).
#[derive(Debug, Clone)]
pub struct SyncOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub elapsed_ms: u64,
}

impl SyncOutput {
    /// True when either stream hit the truncation cap — kept as a
    /// convenience so callers that don't care which stream overflowed
    /// keep a single boolean to check.
    pub fn was_truncated(&self) -> bool {
        self.stdout_truncated || self.stderr_truncated
    }
}

/// Run `command` under `sh -c`, wait up to `timeout_ms`, apply output
/// truncation, and return. Returns Err only on spawn failure. Honors
/// the session worktree stack — if `EnterWorktree` has been fired,
/// the command runs inside the topmost cwd.
pub async fn run(command: &str, timeout_ms: u64) -> std::io::Result<SyncOutput> {
    let start = Instant::now();
    let mut builder = Command::new("sh");
    builder
        .arg("-c")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = crate::tools::deferred::worktree::effective_cwd() {
        builder.current_dir(cwd);
    }
    let mut child = builder.spawn()?;

    let wait_future = async {
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (stdout_bytes, stderr_bytes) = tokio::join!(
            drain_optional(stdout),
            drain_optional(stderr),
        );
        let status = child.wait().await;
        (stdout_bytes, stderr_bytes, status)
    };

    let result = timeout(Duration::from_millis(timeout_ms), wait_future).await;
    let elapsed = start.elapsed().as_millis() as u64;

    match result {
        Ok((stdout, stderr, status)) => {
            let stdout_raw = stdout.unwrap_or_default();
            let stderr_raw = stderr.unwrap_or_default();
            let t_out = truncate::apply(&stdout_raw);
            let t_err = truncate::apply(&stderr_raw);
            let exit_code = match status {
                Ok(s) => s.code().unwrap_or(-1),
                Err(_) => -1,
            };
            Ok(SyncOutput {
                exit_code,
                stdout: t_out.output,
                stderr: t_err.output,
                stdout_truncated: t_out.was_truncated,
                stderr_truncated: t_err.was_truncated,
                timed_out: false,
                elapsed_ms: elapsed,
            })
        }
        Err(_) => {
            // Timeout fired. SIGTERM via start_kill, then grace window
            // before the OS's kill_on_drop delivers SIGKILL on our way out.
            let _ = child.start_kill();
            let _ = timeout(Duration::from_millis(GRACE_PERIOD_MS), child.wait()).await;
            Ok(SyncOutput {
                exit_code: -1,
                stdout: String::new(),
                stderr: String::from("[timeout — process terminated]"),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: true,
                elapsed_ms: start.elapsed().as_millis() as u64,
            })
        }
    }
}

async fn drain_optional<R>(reader: Option<R>) -> tokio::io::Result<String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    if let Some(mut r) = reader {
        r.read_to_string(&mut out).await?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echo_hi_succeeds() {
        let out = run("echo hi", 5_000).await.unwrap();
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.starts_with("hi"));
        assert!(out.stderr.is_empty());
        assert!(!out.timed_out);
        assert!(out.elapsed_ms < 5_000);
    }

    #[tokio::test]
    async fn nonzero_exit_preserved() {
        let out = run("false", 2_000).await.unwrap();
        assert_eq!(out.exit_code, 1);
        assert!(!out.timed_out);
    }

    #[tokio::test]
    async fn timeout_kills_long_running() {
        let out = run("sleep 5", 300).await.unwrap();
        assert!(out.timed_out);
        assert!(out.elapsed_ms < 5_000);
    }

    #[tokio::test]
    async fn stdout_and_stderr_surface_separately() {
        let out = run("echo hi; echo err >&2", 2_000).await.unwrap();
        assert!(out.stdout.contains("hi"), "stdout: {:?}", out.stdout);
        assert!(!out.stdout.contains("err"), "stdout must not carry stderr text");
        assert!(out.stderr.contains("err"), "stderr: {:?}", out.stderr);
        assert!(!out.stderr.contains("hi"));
    }
}
