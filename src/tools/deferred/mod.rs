//! Wave-3 deferred tools — `EnterPlanMode` / `ExitPlanMode`,
//! `EnterWorktree` / `ExitWorktree`, `TaskOutput` / `TaskStop`,
//! `CronCreate` / `CronDelete` / `CronList`, and `ScheduleWakeup`.
//!
//! These are otherside-native synthesis of the upstream shapes —
//! no capture exists for them yet, so the JSON schemas mirror the
//! Zod types from `tools/<name>/` in upstream 2.1.113. Each
//! dispatcher mutates shared session state via the registries
//! defined here so the TUI and the agent task agree on plan
//! mode / cwd / scheduled wakeups without threading context.
//!
//! # Design notes
//!
//! - Plan mode: a process-wide flag backed by `AtomicBool`. Setting
//!   it flips the inference-time `permission_mode` read in
//!   `run_agent_turns` so the next tool call sees plan-mode semantics.
//! - Worktree cwd: a session-scoped `Mutex<Vec<PathBuf>>` stack. The
//!   Bash / Read / Write / Edit dispatchers consult
//!   [`worktree::effective_cwd`] to resolve relative paths; when the
//!   stack is empty the process cwd wins.
//! - Cron + ScheduleWakeup: a session-scoped registry with a
//!   `HashMap<CronId, CronEntry>` for `/cron-*` tools, and a one-shot
//!   wakeup list for `ScheduleWakeup`. Neither fires a side-effect
//!   on its own today — the agent task inspects the registry via
//!   `CronList` / a follow-up drain pass — but the registry shape is
//!   in place so future wakeup delivery is a pure consumer change.
//! - TaskOutput / TaskStop: piggyback on the existing
//!   [`super::task`] registry. `TaskStop` sets status = cancelled;
//!   `TaskOutput` returns the task description + any metadata-captured
//!   output so the model sees log-like content.
//!
//! Schemas are otherside-native. The tool names ARE upstream training
//! anchors (per R-20) so the strings stay verbatim.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::tools::ToolError;

// ---------------------------------------------------------------------
// Plan mode — process-wide atomic toggled by EnterPlanMode/ExitPlanMode.
// ---------------------------------------------------------------------

/// Session plan-mode flag. When `true`, the agent task's dispatch
/// gate treats mutating tools as denied (delegates to
/// `PermissionMode::Plan`) regardless of the session's base mode.
static PLAN_MODE: AtomicBool = AtomicBool::new(false);

/// True when the model has asked for plan mode via [`EnterPlanMode`].
pub fn plan_mode_active() -> bool {
    PLAN_MODE.load(Ordering::Relaxed)
}

/// Reset the flag. Test-only — production flips through the tool
/// dispatchers.
#[cfg(test)]
pub fn reset_plan_mode() {
    PLAN_MODE.store(false, Ordering::Relaxed);
}

pub fn enter_plan_mode(_args: &Value) -> Result<Value, ToolError> {
    PLAN_MODE.store(true, Ordering::Relaxed);
    Ok(json!({
        "ok": true,
        "mode": "plan",
        "message": "Plan mode engaged. Every mutating tool will be denied until ExitPlanMode fires.",
    }))
}

pub fn exit_plan_mode(_args: &Value) -> Result<Value, ToolError> {
    PLAN_MODE.store(false, Ordering::Relaxed);
    Ok(json!({
        "ok": true,
        "mode": "default",
        "message": "Plan mode cleared.",
    }))
}

// ---------------------------------------------------------------------
// Worktree cwd stack — EnterWorktree pushes, ExitWorktree pops.
// ---------------------------------------------------------------------

pub mod worktree {
    use super::*;

    fn stack() -> &'static Mutex<Vec<PathBuf>> {
        static STACK: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
        STACK.get_or_init(|| Mutex::new(Vec::new()))
    }

    /// Current top-of-stack cwd override, or `None` when the stack is
    /// empty (process cwd wins).
    pub fn effective_cwd() -> Option<PathBuf> {
        stack().lock().ok().and_then(|s| s.last().cloned())
    }

    /// Push a new cwd onto the stack.
    pub fn push(path: PathBuf) {
        if let Ok(mut s) = stack().lock() {
            s.push(path);
        }
    }

    /// Pop the current cwd. Returns the popped path, or `None` when
    /// the stack was already empty.
    pub fn pop() -> Option<PathBuf> {
        stack().lock().ok().and_then(|mut s| s.pop())
    }

    /// Test helper — wipes the stack.
    #[cfg(test)]
    pub fn clear() {
        if let Ok(mut s) = stack().lock() {
            s.clear();
        }
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
    worktree::push(buf.clone());
    Ok(json!({
        "ok": true,
        "cwd": buf,
        "depth": worktree::effective_cwd()
            .map(|_| 1u64)
            .unwrap_or(0)
    }))
}

pub fn exit_worktree(_args: &Value) -> Result<Value, ToolError> {
    match worktree::pop() {
        Some(path) => Ok(json!({
            "ok": true,
            "popped": path,
            "restored": worktree::effective_cwd(),
        })),
        None => Ok(json!({
            "ok": false,
            "error": "worktree stack is empty; nothing to exit",
        })),
    }
}

// ---------------------------------------------------------------------
// TaskOutput / TaskStop — piggyback on super::task registry.
// ---------------------------------------------------------------------

pub fn task_output(args: &Value) -> Result<Value, ToolError> {
    let task_id = args
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("`taskId` is required".into()))?;
    let got = super::task::task_get(&json!({ "taskId": task_id }))?;
    if got["task"].is_null() {
        return Ok(json!({
            "taskId": task_id,
            "output": null,
            "error": "task not found",
        }));
    }
    let task = &got["task"];
    // Compose a deterministic output blob: subject + status + any
    // metadata fields named `output`, `logs`, or `stdout`. Users can
    // seed logs via `TaskUpdate(metadata)` and read them back here.
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "[{}] {}",
        task["status"].as_str().unwrap_or("unknown"),
        task["subject"].as_str().unwrap_or("")
    ));
    if let Some(desc) = task["description"].as_str() {
        if !desc.is_empty() {
            lines.push(desc.to_string());
        }
    }
    for key in ["output", "logs", "stdout"] {
        if let Some(v) = task["metadata"].get(key) {
            let text = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if !text.is_empty() {
                lines.push(text);
            }
        }
    }
    Ok(json!({
        "taskId": task_id,
        "status": task["status"].clone(),
        "output": lines.join("\n"),
    }))
}

pub fn task_stop(args: &Value) -> Result<Value, ToolError> {
    let task_id = args
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("`taskId` is required".into()))?;
    // Fold into the existing update dispatch so statusChange renders
    // through the same path.
    let out = super::task::task_update(&json!({
        "taskId": task_id,
        "status": "cancelled",
    }))?;
    Ok(json!({
        "taskId": task_id,
        "success": out["success"].clone(),
        "statusChange": out["statusChange"].clone(),
    }))
}

// ---------------------------------------------------------------------
// Cron registry + ScheduleWakeup — session-scoped schedulers.
// ---------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CronEntry {
    pub id: String,
    pub prompt: String,
    pub interval_ms: u64,
    pub created_at: u64,
    pub last_fired_at: Option<u64>,
}

fn cron_registry() -> &'static Mutex<HashMap<String, CronEntry>> {
    static REG: OnceLock<Mutex<HashMap<String, CronEntry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_cron_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("cron-{n:04}")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse a duration string like `"5m"`, `"30s"`, `"2h"` into
/// milliseconds. Returns `None` on malformed input. Accepted units:
/// `s` seconds, `m` minutes, `h` hours. Bare numbers are interpreted
/// as minutes to match the upstream `/loop 5` convention.
fn parse_interval(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (num_part, unit) = s.split_at(
        s.find(|c: char| !c.is_ascii_digit())
            .unwrap_or(s.len()),
    );
    let n: u64 = num_part.parse().ok()?;
    if n == 0 {
        return None;
    }
    let millis = match unit.trim() {
        "" | "m" | "min" | "mins" | "minute" | "minutes" => n.saturating_mul(60_000),
        "s" | "sec" | "secs" | "second" | "seconds" => n.saturating_mul(1_000),
        "h" | "hr" | "hour" | "hours" => n.saturating_mul(3_600_000),
        _ => return None,
    };
    Some(millis)
}

pub fn cron_create(args: &Value) -> Result<Value, ToolError> {
    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("`prompt` is required".into()))?;
    let interval_raw = args
        .get("interval")
        .and_then(Value::as_str)
        .unwrap_or("10m");
    let interval_ms = parse_interval(interval_raw).ok_or_else(|| {
        ToolError::InvalidArgs(format!(
            "invalid interval `{interval_raw}` (expected e.g. `30s`, `5m`, `1h`)"
        ))
    })?;
    let id = next_cron_id();
    let entry = CronEntry {
        id: id.clone(),
        prompt: prompt.to_string(),
        interval_ms,
        created_at: now_millis(),
        last_fired_at: None,
    };
    cron_registry()
        .lock()
        .map_err(|e| ToolError::InvalidArgs(format!("cron registry lock poisoned: {e}")))?
        .insert(id.clone(), entry);
    Ok(json!({
        "id": id,
        "intervalMs": interval_ms,
        "prompt": prompt,
    }))
}

pub fn cron_delete(args: &Value) -> Result<Value, ToolError> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("`id` is required".into()))?;
    let existed = cron_registry()
        .lock()
        .map_err(|e| ToolError::InvalidArgs(format!("cron registry lock poisoned: {e}")))?
        .remove(id)
        .is_some();
    Ok(json!({
        "id": id,
        "deleted": existed,
    }))
}

pub fn cron_list(_args: &Value) -> Result<Value, ToolError> {
    let guard = cron_registry()
        .lock()
        .map_err(|e| ToolError::InvalidArgs(format!("cron registry lock poisoned: {e}")))?;
    let mut entries: Vec<&CronEntry> = guard.values().collect();
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    let items: Vec<Value> = entries
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "prompt": e.prompt,
                "intervalMs": e.interval_ms,
                "createdAt": e.created_at,
                "lastFiredAt": e.last_fired_at,
            })
        })
        .collect();
    Ok(json!({ "entries": items }))
}

#[cfg(test)]
pub fn clear_cron_registry() {
    if let Ok(mut g) = cron_registry().lock() {
        g.clear();
    }
}

// ScheduleWakeup — one-shot timer registry. A future background task
// will drain `pending_wakeups()` and fire notifications; for now we
// surface the registration so the model can confirm placement + the
// TUI can list pending timers via a `/wakeups` slash (follow-up).

#[derive(Debug, Clone)]
pub struct WakeupEntry {
    pub id: String,
    pub fire_at: u64,
    pub message: String,
    pub created_at: u64,
}

fn wakeup_registry() -> &'static Mutex<Vec<WakeupEntry>> {
    static REG: OnceLock<Mutex<Vec<WakeupEntry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Vec::new()))
}

fn next_wakeup_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("wake-{n:04}")
}

pub fn schedule_wakeup(args: &Value) -> Result<Value, ToolError> {
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("`message` is required".into()))?;
    let in_ms = args
        .get("inMs")
        .and_then(Value::as_u64)
        .or_else(|| {
            args.get("in")
                .and_then(Value::as_str)
                .and_then(parse_interval)
        })
        .ok_or_else(|| ToolError::InvalidArgs("`inMs` or `in` (duration) required".into()))?;
    if in_ms == 0 {
        return Err(ToolError::InvalidArgs(
            "wakeup delay must be > 0".into(),
        ));
    }
    let now = now_millis();
    let entry = WakeupEntry {
        id: next_wakeup_id(),
        fire_at: now.saturating_add(in_ms),
        message: message.to_string(),
        created_at: now,
    };
    let id = entry.id.clone();
    let fire_at = entry.fire_at;
    wakeup_registry()
        .lock()
        .map_err(|e| ToolError::InvalidArgs(format!("wakeup registry lock poisoned: {e}")))?
        .push(entry);
    Ok(json!({
        "id": id,
        "fireAt": fire_at,
        "inMs": in_ms,
        "message": message,
    }))
}

/// Drain every wakeup whose `fire_at` has passed. Used by the TUI
/// event loop on every spinner tick to surface ready-to-fire
/// messages inline.
pub fn drain_due_wakeups() -> Vec<WakeupEntry> {
    let now = now_millis();
    let mut guard = match wakeup_registry().lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let due: Vec<WakeupEntry> = guard.iter().filter(|w| w.fire_at <= now).cloned().collect();
    guard.retain(|w| w.fire_at > now);
    due
}

#[cfg(test)]
pub fn clear_wakeup_registry() {
    if let Ok(mut g) = wakeup_registry().lock() {
        g.clear();
    }
}

// ---------------------------------------------------------------------
// Schemas.
// ---------------------------------------------------------------------

pub const TOOL_ENTER_PLAN_MODE_JSON: &str =
    include_str!("../../../harness_corpus/tools/EnterPlanMode.json");

pub const TOOL_EXIT_PLAN_MODE_JSON: &str =
    include_str!("../../../harness_corpus/tools/ExitPlanMode.json");

pub const TOOL_ENTER_WORKTREE_JSON: &str =
    include_str!("../../../harness_corpus/tools/EnterWorktree.json");

pub const TOOL_EXIT_WORKTREE_JSON: &str =
    include_str!("../../../harness_corpus/tools/ExitWorktree.json");

pub const TOOL_TASK_OUTPUT_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskOutput.json");

pub const TOOL_TASK_STOP_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskStop.json");

pub const TOOL_CRON_CREATE_JSON: &str =
    include_str!("../../../harness_corpus/tools/CronCreate.json");

pub const TOOL_CRON_DELETE_JSON: &str =
    include_str!("../../../harness_corpus/tools/CronDelete.json");

pub const TOOL_CRON_LIST_JSON: &str =
    include_str!("../../../harness_corpus/tools/CronList.json");

pub const TOOL_ASK_USER_QUESTION_JSON: &str =
    include_str!("../../../harness_corpus/tools/AskUserQuestion.json");

pub const TOOL_SCHEDULE_WAKEUP_JSON: &str =
    include_str!("../../../harness_corpus/tools/ScheduleWakeup.json");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_mode_flips_and_resets() {
        reset_plan_mode();
        assert!(!plan_mode_active());
        enter_plan_mode(&json!({})).unwrap();
        assert!(plan_mode_active());
        exit_plan_mode(&json!({})).unwrap();
        assert!(!plan_mode_active());
    }

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
        worktree::clear();
        let tmp = std::env::temp_dir();
        enter_worktree(&json!({ "path": tmp.to_string_lossy() })).unwrap();
        assert_eq!(worktree::effective_cwd().as_ref(), Some(&tmp));
        exit_worktree(&json!({})).unwrap();
        assert!(worktree::effective_cwd().is_none());
    }

    #[test]
    fn exit_worktree_on_empty_stack_reports_no_op() {
        worktree::clear();
        let out = exit_worktree(&json!({})).unwrap();
        assert_eq!(out["ok"], false);
    }

    #[test]
    fn task_stop_cancels_existing_task() {
        let created =
            super::super::task::task_create(&json!({"subject": "x", "description": "y"})).unwrap();
        let id = created["task"]["id"].as_str().unwrap().to_string();
        let out = task_stop(&json!({ "taskId": &id })).unwrap();
        assert_eq!(out["success"], true);
        let got = super::super::task::task_get(&json!({ "taskId": &id })).unwrap();
        assert_eq!(got["task"]["status"], "cancelled");
    }

    #[test]
    fn task_output_includes_subject_and_metadata() {
        let created =
            super::super::task::task_create(&json!({"subject": "ship it", "description": "pony"}))
                .unwrap();
        let id = created["task"]["id"].as_str().unwrap().to_string();
        super::super::task::task_update(&json!({
            "taskId": &id,
            "metadata": { "output": "log line one\nlog line two" },
        }))
        .unwrap();
        let out = task_output(&json!({ "taskId": &id })).unwrap();
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("ship it"), "subject missing: {text}");
        assert!(text.contains("log line one"), "log missing: {text}");
    }

    #[test]
    fn task_output_unknown_id_returns_null_output() {
        let out = task_output(&json!({ "taskId": "zzz-unknown" })).unwrap();
        assert!(out["output"].is_null());
    }

    #[test]
    fn parse_interval_units() {
        assert_eq!(parse_interval("30s"), Some(30_000));
        assert_eq!(parse_interval("5m"), Some(300_000));
        assert_eq!(parse_interval("2h"), Some(7_200_000));
        assert_eq!(parse_interval("5"), Some(300_000)); // bare minutes
        assert_eq!(parse_interval("bogus"), None);
        assert_eq!(parse_interval("0s"), None);
    }

    #[test]
    fn cron_create_list_delete_round_trip() {
        clear_cron_registry();
        let a = cron_create(&json!({
            "prompt": "/status",
            "interval": "5m",
        }))
        .unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        assert_eq!(a["intervalMs"], 300_000);

        let list = cron_list(&json!({})).unwrap();
        let entries = list["entries"].as_array().unwrap();
        assert!(entries.iter().any(|e| e["id"] == id.as_str()));

        let del = cron_delete(&json!({ "id": &id })).unwrap();
        assert_eq!(del["deleted"], true);
        // Deleting again reports false.
        let del2 = cron_delete(&json!({ "id": &id })).unwrap();
        assert_eq!(del2["deleted"], false);
    }

    #[test]
    fn cron_create_requires_prompt() {
        assert!(cron_create(&json!({})).is_err());
    }

    // Wakeup + cron registries are process-wide. Tests that mutate
    // them serialize through this mutex so parallel `cargo test`
    // doesn't cross-contaminate.
    use std::sync::Mutex as StdMutex;
    static WAKEUP_TEST_LOCK: StdMutex<()> = StdMutex::new(());

    #[test]
    fn schedule_wakeup_registers_entry() {
        let _g = WAKEUP_TEST_LOCK.lock().unwrap();
        clear_wakeup_registry();
        let out = schedule_wakeup(&json!({
            "message": "check deploy",
            "inMs": 50_000,
        }))
        .unwrap();
        assert!(out["fireAt"].as_u64().unwrap() > now_millis());
        let still_pending = drain_due_wakeups();
        assert!(
            still_pending.is_empty(),
            "future wakeup must not drain yet (got {} items)",
            still_pending.len()
        );
        clear_wakeup_registry();
    }

    #[test]
    fn schedule_wakeup_fires_when_due() {
        let _g = WAKEUP_TEST_LOCK.lock().unwrap();
        clear_wakeup_registry();
        schedule_wakeup(&json!({
            "message": "overdue-unique-token",
            "inMs": 1u64,
        }))
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        let due = drain_due_wakeups();
        assert!(
            due.iter().any(|w| w.message == "overdue-unique-token"),
            "due drain must include our registration — got {} items",
            due.len()
        );
        // Second drain should not surface the same one.
        let second = drain_due_wakeups();
        assert!(
            !second.iter().any(|w| w.message == "overdue-unique-token"),
            "drained wakeup should not re-appear"
        );
        clear_wakeup_registry();
    }

    #[test]
    fn schedule_wakeup_rejects_zero_delay() {
        assert!(schedule_wakeup(&json!({
            "message": "zero",
            "inMs": 0u64,
        }))
        .is_err());
    }

    #[test]
    fn all_schemas_parse_as_json() {
        for raw in [
            TOOL_ENTER_PLAN_MODE_JSON,
            TOOL_EXIT_PLAN_MODE_JSON,
            TOOL_ENTER_WORKTREE_JSON,
            TOOL_EXIT_WORKTREE_JSON,
            TOOL_TASK_OUTPUT_JSON,
            TOOL_TASK_STOP_JSON,
            TOOL_CRON_CREATE_JSON,
            TOOL_CRON_DELETE_JSON,
            TOOL_CRON_LIST_JSON,
            TOOL_SCHEDULE_WAKEUP_JSON,
        ] {
            let _: Value = serde_json::from_str(raw).expect("schema JSON well-formed");
        }
    }
}

// Unused outside drainer — hide the dead_code noise since integration
// points (cron tick, wakeup surface) are still being wired.
#[allow(dead_code)]
const _DRAIN_USAGE: fn() -> Vec<WakeupEntry> = drain_due_wakeups;
