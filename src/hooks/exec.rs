

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use super::events::{env_for, EventCtx};
use super::HookOutcome;
use crate::config::settings::HookEntry;

const OUTPUT_CAP_BYTES: usize = 64 * 1024;

const GRACE_PERIOD_MS: u64 = 2_000;

pub async fn fire_entry(entry: &HookEntry, ctx: &EventCtx, timeout_ms: u64) -> HookOutcome {
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(&entry.command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env_for(ctx) {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return HookOutcome::SpawnFailed(e.to_string()),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let wait_future = async {
        let (stdout_bytes, stderr_bytes) = tokio::join!(
            drain_capped(stdout),
            drain_capped(stderr),
        );
        let status = child.wait().await;
        (stdout_bytes, stderr_bytes, status)
    };

    match timeout(Duration::from_millis(timeout_ms), wait_future).await {
        Ok((out, err, status)) => {
            let exit = match status {
                Ok(s) => s.code().unwrap_or(-1),
                Err(_) => -1,
            };
            let stdout = out.unwrap_or_default();
            let stderr = err.unwrap_or_default();
            if exit == 0 {
                HookOutcome::Ok { stdout, stderr, exit }
            } else {
                HookOutcome::NonZeroExit {
                    code: exit,
                    stdout,
                    stderr,
                }
            }
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = timeout(Duration::from_millis(GRACE_PERIOD_MS), child.wait()).await;
            HookOutcome::Timeout
        }
    }
}

async fn drain_capped<R>(reader: Option<R>) -> tokio::io::Result<String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut out = Vec::new();
    if let Some(mut r) = reader {
        let mut buf = [0u8; 4096];
        loop {
            let n = r.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            let remaining = OUTPUT_CAP_BYTES.saturating_sub(out.len());
            let take = n.min(remaining);
            out.extend_from_slice(&buf[..take]);
            if out.len() >= OUTPUT_CAP_BYTES {
                break;
            }
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::HookEntry;
    use crate::hooks::events::PreToolUseCtx;

    fn entry(cmd: &str) -> HookEntry {
        HookEntry {
            matcher: "*".into(),
            command: cmd.into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn successful_hook_returns_ok() {
        let ctx = EventCtx::PreToolUse(PreToolUseCtx {
            tool_name: "Edit".into(),
            tool_input: String::new(),
        });
        let outcome = fire_entry(&entry("echo hi"), &ctx, 2_000).await;
        match outcome {
            HookOutcome::Ok { stdout, exit, .. } => {
                assert!(stdout.contains("hi"));
                assert_eq!(exit, 0);
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn non_zero_exit_surfaced() {
        let ctx = EventCtx::PreToolUse(PreToolUseCtx {
            tool_name: "Edit".into(),
            tool_input: String::new(),
        });
        let outcome = fire_entry(&entry("exit 3"), &ctx, 2_000).await;
        match outcome {
            HookOutcome::NonZeroExit { code, .. } => assert_eq!(code, 3),
            other => panic!("expected NonZeroExit, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn timeout_reports_timeout() {
        let ctx = EventCtx::PreToolUse(PreToolUseCtx {
            tool_name: "Edit".into(),
            tool_input: String::new(),
        });
        let outcome = fire_entry(&entry("sleep 5"), &ctx, 200).await;
        assert!(matches!(outcome, HookOutcome::Timeout));
    }

    #[tokio::test]
    async fn env_vars_reach_subprocess() {
        let ctx = EventCtx::PreToolUse(PreToolUseCtx {
            tool_name: "Edit".into(),
            tool_input: "{\"x\":1}".into(),
        });
        let outcome =
            fire_entry(&entry("echo $TOOL_NAME; echo $TOOL_INPUT"), &ctx, 2_000).await;
        match outcome {
            HookOutcome::Ok { stdout, .. } => {
                assert!(stdout.contains("Edit"));
                assert!(stdout.contains("\"x\":1"));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }
}
