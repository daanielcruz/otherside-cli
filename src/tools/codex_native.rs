//! Codex-native tool set — the tools `codex-cli` advertises over the
//! wire. Mirrors the schemas at
//! `docs/design/codex-openai-auth-api.md §TOOLS`.
//!
//! Deliberately ISOLATED from the claude-code harness
//! (`tools::schemas::tool_schemas()` — 9 tools) per user directive:
//! each provider carries its own tool contract. Codex tools:
//!
//! - `shell`       — exec a command array, blocking, returns stdout/stderr
//! - `apply_patch` — apply a codex-format patch to the filesystem
//!
//! `exec_command` (PTY-persistent), `write_stdin`, `request_permissions`
//! are conditional on upstream config flags and live behind follow-up
//! wiring; the baseline pair above is what a fresh codex session advertises.
//!
//! # Wire shape
//!
//! Codex tools go into the `/responses` body as:
//!
//! ```json
//! {"type": "function", "name": "shell", "description": "...",
//!  "strict": false, "parameters": {...}}
//! ```
//!
//! Distinct from OpenAI's chat.completion `tools[].function` shape
//! (which nests the function under a `function` key). Codex uses the
//! flat `{type, name, description, parameters}` layout.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};

use super::ToolError;

/// `shell` tool schema.
pub const TOOL_SHELL_JSON: &str = r#"{
  "type": "function",
  "name": "shell",
  "description": "Runs a shell command and returns its output. Arguments are passed directly to execvp(). Most commands should be prefixed with [\"bash\", \"-lc\"]. Always set workdir explicitly.",
  "strict": false,
  "parameters": {
    "type": "object",
    "properties": {
      "command":    {"type": "array",  "items": {"type": "string"}, "description": "The command to execute"},
      "workdir":    {"type": "string", "description": "The working directory to execute the command in"},
      "timeout_ms": {"type": "number", "description": "The timeout for the command in milliseconds"}
    },
    "required": ["command"],
    "additionalProperties": false
  }
}"#;

/// `apply_patch` tool schema (JSON variant).
pub const TOOL_APPLY_PATCH_JSON: &str = r#"{
  "type": "function",
  "name": "apply_patch",
  "description": "Apply a patch in the codex patch format to files in the working directory. The patch input MUST begin with `*** Begin Patch` and end with `*** End Patch`.",
  "strict": false,
  "parameters": {
    "type": "object",
    "properties": {
      "input": {"type": "string", "description": "The patch content in codex patch format."}
    },
    "required": ["input"],
    "additionalProperties": false
  }
}"#;

/// Ordered schema list handed to `build_responses_body`.
pub fn tool_schemas_for_responses() -> Vec<Value> {
    [TOOL_SHELL_JSON, TOOL_APPLY_PATCH_JSON]
        .iter()
        .map(|raw| serde_json::from_str(raw).expect("codex tool schema is valid JSON"))
        .collect()
}

// =============================================================================
// Dispatchers — routed from `tools::dispatch` when the active provider is
// codex.
// =============================================================================

/// Execute `shell`. `command` is an argv-style array. `workdir` defaults
/// to the current process cwd; `timeout_ms` defaults to 120_000.
pub fn shell(args: &Value) -> Result<Value, ToolError> {
    let command = args
        .get("command")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::InvalidArgs("`command` must be an array of strings".into()))?;
    let argv: Vec<String> = command
        .iter()
        .map(|v| {
            v.as_str()
                .ok_or_else(|| ToolError::InvalidArgs("command entries must be strings".into()))
                .map(str::to_string)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if argv.is_empty() {
        return Err(ToolError::InvalidArgs("`command` must be non-empty".into()));
    }
    let workdir = args
        .get("workdir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| crate::tools::deferred::worktree::effective_cwd())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(120_000);

    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| ToolError::InvalidArgs("shell tool requires a tokio runtime".into()))?;
    let out = tokio::task::block_in_place(|| {
        handle.block_on(async move {
            run_argv(&argv, &workdir, Duration::from_millis(timeout_ms)).await
        })
    })
    .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;

    Ok(json!({
        "exit_code": out.exit_code,
        "stdout": out.stdout,
        "stderr": out.stderr,
        "timed_out": out.timed_out,
        "elapsed_ms": out.elapsed_ms,
    }))
}

/// Apply a codex-format patch. Parser intentionally minimal — the
/// target surface is the upstream `*** Begin Patch` / `*** End Patch`
/// envelope with `*** Add File:` / `*** Update File:` / `*** Delete
/// File:` sections. Full grammar fidelity is a follow-up; the current
/// implementation supports the common single-file update via the
/// `*** Update File:` block.
pub fn apply_patch(args: &Value) -> Result<Value, ToolError> {
    let input = args
        .get("input")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("`input` is required".into()))?;
    let summary = parse_patch(input)?;
    let mut applied: Vec<String> = Vec::new();
    for action in summary.actions {
        match action {
            PatchAction::Add { path, content } => {
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| ToolError::InvalidArgs(format!("mkdir {parent:?}: {e}")))?;
                }
                std::fs::write(&path, content)
                    .map_err(|e| ToolError::InvalidArgs(format!("write {path}: {e}")))?;
                applied.push(format!("added {path}"));
            }
            PatchAction::Delete { path } => {
                std::fs::remove_file(&path)
                    .map_err(|e| ToolError::InvalidArgs(format!("delete {path}: {e}")))?;
                applied.push(format!("deleted {path}"));
            }
            PatchAction::Update { path, content } => {
                std::fs::write(&path, content)
                    .map_err(|e| ToolError::InvalidArgs(format!("write {path}: {e}")))?;
                applied.push(format!("updated {path}"));
            }
        }
    }
    Ok(json!({
        "applied": applied,
        "count": applied.len(),
    }))
}

#[derive(Debug, Clone)]
enum PatchAction {
    Add { path: String, content: String },
    Update { path: String, content: String },
    Delete { path: String },
}

#[derive(Debug, Default)]
struct Patch {
    actions: Vec<PatchAction>,
}

/// Bare-minimum patch parser. Recognizes the envelope + the three
/// file-action headers. Full hunk semantics (@@ context lines) are
/// NOT yet supported — Add / Update write the verbatim content block
/// that follows the header. This handles the "replace file wholesale"
/// case which is what the model most often emits when asked for a
/// self-contained snippet. Hunk-mode support is a follow-up.
fn parse_patch(input: &str) -> Result<Patch, ToolError> {
    let trimmed = input.trim();
    if !trimmed.starts_with("*** Begin Patch") {
        return Err(ToolError::InvalidArgs(
            "patch must begin with `*** Begin Patch`".into(),
        ));
    }
    if !trimmed.ends_with("*** End Patch") {
        return Err(ToolError::InvalidArgs(
            "patch must end with `*** End Patch`".into(),
        ));
    }
    let body = trimmed
        .trim_start_matches("*** Begin Patch")
        .trim_end_matches("*** End Patch")
        .trim();

    let mut out = Patch::default();
    let mut current: Option<(String, String, String)> = None; // (kind, path, content)
    for raw in body.lines() {
        if let Some(rest) = raw.strip_prefix("*** Add File: ") {
            flush(&mut current, &mut out)?;
            current = Some(("Add".into(), rest.trim().to_string(), String::new()));
        } else if let Some(rest) = raw.strip_prefix("*** Update File: ") {
            flush(&mut current, &mut out)?;
            current = Some(("Update".into(), rest.trim().to_string(), String::new()));
        } else if let Some(rest) = raw.strip_prefix("*** Delete File: ") {
            flush(&mut current, &mut out)?;
            out.actions.push(PatchAction::Delete {
                path: rest.trim().to_string(),
            });
        } else if let Some((_, _, acc)) = current.as_mut() {
            // Strip the leading `+` that codex uses on added lines so
            // the content round-trips to the target file verbatim.
            let line = raw.strip_prefix('+').unwrap_or(raw);
            acc.push_str(line);
            acc.push('\n');
        }
    }
    flush(&mut current, &mut out)?;
    Ok(out)
}

fn flush(
    current: &mut Option<(String, String, String)>,
    out: &mut Patch,
) -> Result<(), ToolError> {
    if let Some((kind, path, content)) = current.take() {
        match kind.as_str() {
            "Add" => out.actions.push(PatchAction::Add { path, content }),
            "Update" => out.actions.push(PatchAction::Update { path, content }),
            other => {
                return Err(ToolError::InvalidArgs(format!(
                    "unknown patch action `{other}`"
                )))
            }
        }
    }
    Ok(())
}

// =============================================================================
// Shell executor
// =============================================================================

#[derive(Debug, Clone)]
struct ShellOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
    elapsed_ms: u64,
}

async fn run_argv(
    argv: &[String],
    workdir: &std::path::Path,
    timeout: Duration,
) -> std::io::Result<ShellOutput> {
    use std::time::Instant;
    use tokio::process::Command;

    let start = Instant::now();
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn()?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let drain = async move {
        let (o, e) = tokio::join!(drain(stdout), drain(stderr));
        (o, e)
    };

    let waited = tokio::time::timeout(timeout, async {
        let (out, err) = drain.await;
        let status = child.wait().await;
        (out, err, status)
    })
    .await;

    match waited {
        Ok((stdout, stderr, status)) => {
            let exit_code = match status {
                Ok(s) => s.code().unwrap_or(-1),
                Err(_) => -1,
            };
            Ok(ShellOutput {
                exit_code,
                stdout: stdout.unwrap_or_default(),
                stderr: stderr.unwrap_or_default(),
                timed_out: false,
                elapsed_ms: start.elapsed().as_millis() as u64,
            })
        }
        Err(_) => {
            let _ = child.start_kill();
            Ok(ShellOutput {
                exit_code: -1,
                stdout: String::new(),
                stderr: "[timeout - process terminated]".to_string(),
                timed_out: true,
                elapsed_ms: start.elapsed().as_millis() as u64,
            })
        }
    }
}

async fn drain<R>(reader: Option<R>) -> Option<String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut r = reader?;
    let mut s = String::new();
    r.read_to_string(&mut s).await.ok()?;
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_requires_command_array() {
        let err = shell(&json!({"command": "ls"})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn shell_empty_command_errors() {
        let err = shell(&json!({"command": []})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shell_runs_echo() {
        let out = shell(&json!({"command": ["echo", "hi"]})).unwrap();
        assert_eq!(out["exit_code"], 0);
        assert!(out["stdout"].as_str().unwrap().contains("hi"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shell_respects_workdir() {
        let tmp = std::env::temp_dir();
        let out = shell(&json!({
            "command": ["pwd"],
            "workdir": tmp.to_string_lossy(),
        }))
        .unwrap();
        assert_eq!(out["exit_code"], 0);
        let pwd = out["stdout"].as_str().unwrap().trim();
        // macOS resolves /tmp through the /private/tmp symlink.
        assert!(
            pwd == tmp.to_string_lossy() || pwd == std::fs::canonicalize(&tmp).unwrap().to_string_lossy(),
            "pwd {pwd} vs tmp {}",
            tmp.display()
        );
    }

    #[test]
    fn tool_schemas_for_responses_emits_flat_function_shape() {
        let v = tool_schemas_for_responses();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0]["type"], "function");
        assert_eq!(v[0]["name"], "shell");
        assert_eq!(v[1]["name"], "apply_patch");
        // Codex uses a FLAT shape — no nested "function" key.
        assert!(v[0].get("function").is_none());
    }

    #[test]
    fn apply_patch_requires_envelope() {
        assert!(apply_patch(&json!({"input": "hello"})).is_err());
        assert!(apply_patch(&json!({"input": "*** Begin Patch\n"})).is_err());
    }

    #[test]
    fn apply_patch_add_and_delete_round_trip() {
        let path = std::env::temp_dir().join(format!(
            "codex_patch_{}.txt",
            uuid::Uuid::new_v4().simple()
        ));
        let patch = format!(
            "*** Begin Patch\n*** Add File: {p}\n+line one\n+line two\n*** End Patch",
            p = path.display()
        );
        let out = apply_patch(&json!({"input": patch})).unwrap();
        assert_eq!(out["count"], 1);
        let got = std::fs::read_to_string(&path).unwrap();
        assert_eq!(got.trim(), "line one\nline two");

        let delete_patch = format!(
            "*** Begin Patch\n*** Delete File: {p}\n*** End Patch",
            p = path.display()
        );
        let out = apply_patch(&json!({"input": delete_patch})).unwrap();
        assert_eq!(out["count"], 1);
        assert!(!path.exists());
    }
}
