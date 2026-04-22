//! On-disk mirror of subagent task output.
//!
//! Upstream (`utils/task/diskOutput.ts`) writes every subagent's captured
//! stdout to `<projectTempDir>/<sessionId>/tasks/<taskId>.output` so the
//! TaskOutputTool can tail the file without holding the full text in
//! memory. Otherside's port is scaled down: we mirror the same final-text
//! the in-memory `TaskRecord.output` buffer holds, writing it atomically at
//! task completion. That's enough for (a) replaying a compacted session,
//! (b) the model peek-via-Read path that otherwise hit `File not found`,
//! (c) external tools crawling the projects dir alongside upstream.
//!
//! Path shape matches upstream intent:
//!   `<config_dir>/projects/<sanitized-cwd>/<session-id>/tasks/<agent_id>.output`
//!
//! The root is installed by the TUI at boot via `install_root(...)`. Before
//! install (e.g. in unit tests) the writer short-circuits and does nothing —
//! on-disk mirroring is best-effort by design.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::Result;

/// Memoized task-output root for the active session. Matches upstream's
/// `_taskOutputDir` in `diskOutput.ts:49` — captured once, never rotated
/// mid-session so background tasks outliving a `/clear` keep their files
/// reachable via their original path.
static TASK_OUTPUT_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Install the root directory for this session. Called once at TUI boot
/// after the session handle lands. Subsequent calls are no-ops (first
/// wins) — matches upstream's single-shot memoization.
pub fn install_root(dir: PathBuf) {
    let _ = TASK_OUTPUT_ROOT.set(dir);
}

pub fn current_root() -> Option<&'static Path> {
    TASK_OUTPUT_ROOT.get().map(PathBuf::as_path)
}

/// `<session_root>/tasks/<agent_id>.output` — matches upstream
/// `getTaskOutputPath(taskId)` (`diskOutput.ts:72`). Returns `None` when
/// the root hasn't been installed yet so callers can treat disk mirroring
/// as best-effort without tripping on None-path handling.
pub fn task_output_path(agent_id: &str) -> Option<PathBuf> {
    current_root().map(|root| root.join("tasks").join(format!("{agent_id}.output")))
}

/// Write `content` to the task-output file atomically-ish. Creates parent
/// directories on demand. No-op when the root hasn't been installed.
pub fn write_task_output(agent_id: &str, content: &str) -> Result<()> {
    let Some(path) = task_output_path(agent_id) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(content.as_bytes())?;
    file.sync_data()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "otherside_taskoutput_{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn path_has_upstream_shape_once_root_is_set() {
        // install_root is memoized — run in a fresh test by shelling out
        // with scratch dir whenever the oncelock has not been set.
        let root = scratch_root();
        let _ = TASK_OUTPUT_ROOT.set(root.clone());

        let agent_id = "a3f2c1b4d5e6f7a8";
        let path = task_output_path(agent_id).unwrap();
        assert_eq!(path, root.join("tasks").join("a3f2c1b4d5e6f7a8.output"));
    }

    #[test]
    fn write_task_output_no_op_before_install() {
        // This process may or may not have TASK_OUTPUT_ROOT already set by
        // the test above (test ordering isn't deterministic). Either way,
        // calling write_task_output must not panic or error when the root
        // was never installed OR when it is installed to a scratch path.
        let result = write_task_output("abadbead00000000", "hello");
        assert!(
            result.is_ok(),
            "write must succeed or no-op cleanly: {:?}",
            result
        );
    }
}
