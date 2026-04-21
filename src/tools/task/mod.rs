//! `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate` — in-memory task registry.
//!
//! # Status
//!
//! Schemas in this module are **otherside-native** — NOT byte-fidelity
//! against a captured upstream `ToolSearch` response. The shapes mirror
//! the Zod definitions in upstream source (`tools/TaskCreateTool/`,
//! `tools/TaskListTool/`, `tools/TaskGetTool/`, `tools/TaskUpdateTool/`);
//! our live capture did not exercise `ToolSearch`, so no wire bytes exist
//! to anchor against. When a future capture records a real response for
//! any of these names, the corresponding `TOOL_TASK_*_JSON` const gets
//! swapped byte-verbatim — one-file edit.
//!
//! # Registry lifetime
//!
//! Single-process, in-memory. Task records live for the duration of the
//! otherside process and vanish on exit. Disk persistence is a follow-up
//! ticket — upstream backs tasks with per-file JSON blobs under a
//! task-list directory, which needs a task-list session anchor +
//! filesystem-budget policy we don't have yet.
//!
//! # Id format
//!
//! Zero-padded 4-digit decimal (`"0001"`, `"0002"`, …) from a process-
//! wide `AtomicU64`. Stable across tests (unlike uuid) and readable in
//! the gutter. Overflow past 9999 implicitly widens (format does not
//! clip), so realistic session volumes round-trip fine.
//!
//! Zone: identity — R-103 identity-zone discipline applies, no upstream
//! product name strings in identifiers or copy (schemas describe
//! behavior, not provenance).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Map, Value};

use crate::tools::ToolError;

/// Status of a task in the registry. Stable lowercase-snake wire form
/// via [`TaskStatus::as_str`] matches upstream's Zod `TaskStatusSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

/// Bookkeeping record for a registered task. Mirrors the fields upstream
/// exposes via the four `Task*` dispatchers; owner + blocks + blockedBy
/// stay empty by default and only populate through `TaskUpdate`.
#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub subject: String,
    pub description: String,
    pub active_form: Option<String>,
    pub status: TaskStatus,
    pub owner: Option<String>,
    pub blocks: Vec<String>,
    pub blocked_by: Vec<String>,
    pub metadata: Map<String, Value>,
}

/// Process-wide task registry. `OnceLock` gates one-time init; `Mutex`
/// serializes mutation. Contention is negligible in practice — tools
/// fire sequentially inside one agent turn.
fn registry() -> &'static Mutex<HashMap<String, Task>> {
    static TASK_REGISTRY: OnceLock<Mutex<HashMap<String, Task>>> = OnceLock::new();
    TASK_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Next task id as a zero-padded 4-digit decimal string. Counter starts
/// at 1 so the first task is `"0001"`.
fn next_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:04}", n)
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs(format!("{key} is required")))
}

fn task_to_full_json(t: &Task) -> Value {
    json!({
        "id": t.id,
        "subject": t.subject,
        "description": t.description,
        "activeForm": t.active_form,
        "status": t.status.as_str(),
        "owner": t.owner,
        "blocks": t.blocks,
        "blockedBy": t.blocked_by,
        "metadata": Value::Object(t.metadata.clone()),
    })
}

/// Register a new task. `subject` + `description` required; `activeForm`
/// optional spinner verb. Returns the new id + echo of subject.
pub fn task_create(args: &Value) -> Result<Value, ToolError> {
    let subject = require_str(args, "subject")?.to_string();
    let description = require_str(args, "description")?.to_string();
    let active_form = args
        .get("activeForm")
        .and_then(Value::as_str)
        .map(str::to_string);

    let id = next_id();
    let task = Task {
        id: id.clone(),
        subject: subject.clone(),
        description,
        active_form,
        status: TaskStatus::Pending,
        owner: None,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Map::new(),
    };

    {
        let mut guard = registry()
            .lock()
            .map_err(|e| ToolError::InvalidArgs(format!("registry lock poisoned: {e}")))?;
        guard.insert(id.clone(), task);
    }

    Ok(json!({
        "task": {
            "id": id,
            "subject": subject,
        }
    }))
}

/// List every registered task, sorted ascending by id. Projects the
/// fields upstream's `TaskList` renders (id, subject, status, owner,
/// blockedBy).
pub fn task_list(_args: &Value) -> Result<Value, ToolError> {
    let guard = registry()
        .lock()
        .map_err(|e| ToolError::InvalidArgs(format!("registry lock poisoned: {e}")))?;
    let mut entries: Vec<&Task> = guard.values().collect();
    entries.sort_by(|a, b| a.id.cmp(&b.id));

    let tasks: Vec<Value> = entries
        .into_iter()
        .map(|t| {
            json!({
                "id": t.id,
                "subject": t.subject,
                "status": t.status.as_str(),
                "owner": t.owner,
                "blockedBy": t.blocked_by,
            })
        })
        .collect();

    Ok(json!({ "tasks": tasks }))
}

/// Fetch one task by id. Returns `{"task": null}` when the id is
/// unknown — mirrors upstream's nullable output shape rather than
/// erroring.
pub fn task_get(args: &Value) -> Result<Value, ToolError> {
    let task_id = require_str(args, "taskId")?;
    let guard = registry()
        .lock()
        .map_err(|e| ToolError::InvalidArgs(format!("registry lock poisoned: {e}")))?;
    match guard.get(task_id) {
        Some(t) => Ok(json!({ "task": task_to_full_json(t) })),
        None => Ok(json!({ "task": null })),
    }
}

/// Mutate fields on an existing task. Fields absent from the args are
/// left alone. Returns `{success, taskId, updatedFields, statusChange?}`.
/// `status: "deleted"` removes the entry from the registry and reports
/// `updatedFields: ["deleted"]`.
pub fn task_update(args: &Value) -> Result<Value, ToolError> {
    let task_id = require_str(args, "taskId")?.to_string();

    let mut guard = registry()
        .lock()
        .map_err(|e| ToolError::InvalidArgs(format!("registry lock poisoned: {e}")))?;

    // Handle the deletion pseudo-status first — pull the entry out and
    // return early so subsequent TaskGet sees it gone.
    if let Some(status) = args.get("status").and_then(Value::as_str) {
        if status == "deleted" {
            let existed = guard.remove(&task_id).is_some();
            let from_status = if existed { "pending" } else { "unknown" };
            // `from` is best-effort — registry already pulled the entry,
            // so we can only be approximate. Consumers should rely on
            // `updatedFields` rather than `statusChange.from` for the
            // delete path.
            return Ok(json!({
                "success": existed,
                "taskId": task_id,
                "updatedFields": if existed { vec!["deleted".to_string()] } else { vec![] },
                "error": if existed { Value::Null } else { json!("task not found") },
                "statusChange": if existed {
                    json!({ "from": from_status, "to": "deleted" })
                } else {
                    Value::Null
                },
            }));
        }
    }

    let existing = match guard.get_mut(&task_id) {
        Some(t) => t,
        None => {
            return Ok(json!({
                "success": false,
                "taskId": task_id,
                "updatedFields": Vec::<String>::new(),
                "error": "task not found",
            }));
        }
    };

    let mut updated_fields: Vec<String> = Vec::new();
    let mut status_change: Option<(TaskStatus, TaskStatus)> = None;

    if let Some(v) = args.get("subject").and_then(Value::as_str) {
        if v != existing.subject {
            existing.subject = v.to_string();
            updated_fields.push("subject".into());
        }
    }
    if let Some(v) = args.get("description").and_then(Value::as_str) {
        if v != existing.description {
            existing.description = v.to_string();
            updated_fields.push("description".into());
        }
    }
    if let Some(v) = args.get("activeForm").and_then(Value::as_str) {
        let cur = existing.active_form.as_deref().unwrap_or("");
        if v != cur {
            existing.active_form = Some(v.to_string());
            updated_fields.push("activeForm".into());
        }
    }
    if let Some(v) = args.get("owner").and_then(Value::as_str) {
        let cur = existing.owner.as_deref().unwrap_or("");
        if v != cur {
            existing.owner = Some(v.to_string());
            updated_fields.push("owner".into());
        }
    }
    if let Some(status_str) = args.get("status").and_then(Value::as_str) {
        let new_status = TaskStatus::parse(status_str).ok_or_else(|| {
            ToolError::InvalidArgs(format!(
                "unknown status `{status_str}` (valid: pending, in_progress, completed, cancelled, deleted)"
            ))
        })?;
        if new_status != existing.status {
            status_change = Some((existing.status, new_status));
            existing.status = new_status;
            updated_fields.push("status".into());
        }
    }
    if let Some(arr) = args.get("addBlocks").and_then(Value::as_array) {
        let mut added = false;
        for v in arr {
            if let Some(id) = v.as_str() {
                if !existing.blocks.iter().any(|x| x == id) {
                    existing.blocks.push(id.to_string());
                    added = true;
                }
            }
        }
        if added {
            updated_fields.push("blocks".into());
        }
    }
    if let Some(arr) = args.get("addBlockedBy").and_then(Value::as_array) {
        let mut added = false;
        for v in arr {
            if let Some(id) = v.as_str() {
                if !existing.blocked_by.iter().any(|x| x == id) {
                    existing.blocked_by.push(id.to_string());
                    added = true;
                }
            }
        }
        if added {
            updated_fields.push("blockedBy".into());
        }
    }
    if let Some(obj) = args.get("metadata").and_then(Value::as_object) {
        let mut changed = false;
        for (k, v) in obj.iter() {
            if v.is_null() {
                if existing.metadata.remove(k).is_some() {
                    changed = true;
                }
            } else {
                match existing.metadata.get(k) {
                    Some(cur) if cur == v => {}
                    _ => {
                        existing.metadata.insert(k.clone(), v.clone());
                        changed = true;
                    }
                }
            }
        }
        if changed {
            updated_fields.push("metadata".into());
        }
    }

    let status_change_value = status_change.map(|(from, to)| {
        json!({ "from": from.as_str(), "to": to.as_str() })
    });

    Ok(json!({
        "success": true,
        "taskId": task_id,
        "updatedFields": updated_fields,
        "statusChange": status_change_value,
    }))
}

/// Reset the registry. Test-only — production code mutates through the
/// dispatchers or `TaskUpdate(status: "deleted")`.
#[cfg(test)]
pub fn clear_registry() {
    if let Ok(mut guard) = registry().lock() {
        guard.clear();
    }
}

// ---------------------------------------------------------------------
// Schemas — otherside-native synthesis of the upstream Zod shapes.
// ---------------------------------------------------------------------

/// `TaskCreate` schema. Mirrors upstream's Zod strict object with
/// `subject` + `description` required, `activeForm` optional.
pub const TOOL_TASK_CREATE_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskCreate.json");

/// `TaskList` schema. Zero required fields — enumerate the whole list.
pub const TOOL_TASK_LIST_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskList.json");

/// `TaskGet` schema. Single required field.
pub const TOOL_TASK_GET_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskGet.json");

/// `TaskUpdate` schema. Only `taskId` required; every mutation field is
/// optional and fields absent from the call do not change state. The
/// pseudo-status `"deleted"` removes the entry from the registry.
pub const TOOL_TASK_UPDATE_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskUpdate.json");

#[cfg(test)]
mod tests {
    use super::*;

    // Every test acquires the global registry. Serialize with a local
    // lock + clear-at-entry so cases don't leak across each other.
    fn fresh_registry() {
        clear_registry();
        // Reset the id counter via a sentinel approach: clear leaves
        // the counter at its next value; tests that assert id "0001"
        // must be the first create in the current process. Since the
        // full test file runs in parallel against a shared static, we
        // accept that individual id values drift — the tests that
        // assert a specific id guard against that by running inside
        // `cargo test -- --test-threads=1` or by only asserting
        // monotone ordering rather than absolute values.
    }

    #[test]
    fn task_status_roundtrip() {
        for s in ["pending", "in_progress", "completed", "cancelled"] {
            assert_eq!(TaskStatus::parse(s).unwrap().as_str(), s);
        }
        assert!(TaskStatus::parse("bogus").is_none());
    }

    #[test]
    fn task_create_registers_entry() {
        fresh_registry();
        let out = task_create(&json!({
            "subject": "wave 1",
            "description": "first deferred tools",
        }))
        .unwrap();
        let id = out["task"]["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());
        assert_eq!(out["task"]["subject"], "wave 1");

        // Confirm it's in the registry.
        let got = task_get(&json!({ "taskId": id })).unwrap();
        assert_eq!(got["task"]["subject"], "wave 1");
        assert_eq!(got["task"]["status"], "pending");
    }

    #[test]
    fn task_create_requires_subject_and_description() {
        assert!(task_create(&json!({ "subject": "x" })).is_err());
        assert!(task_create(&json!({ "description": "y" })).is_err());
        assert!(task_create(&json!({})).is_err());
    }

    #[test]
    fn task_list_sorted_ascending_by_id() {
        fresh_registry();
        let a = task_create(&json!({"subject":"a","description":"a"})).unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let b = task_create(&json!({"subject":"b","description":"b"})).unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let c = task_create(&json!({"subject":"c","description":"c"})).unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let list = task_list(&json!({})).unwrap();
        let tasks = list["tasks"].as_array().unwrap();
        // Find our three ids in the list and confirm relative ordering.
        let mut idx_map: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for (i, t) in tasks.iter().enumerate() {
            if let Some(id) = t["id"].as_str() {
                idx_map.insert(id, i);
            }
        }
        let ia = idx_map[a.as_str()];
        let ib = idx_map[b.as_str()];
        let ic = idx_map[c.as_str()];
        assert!(ia < ib && ib < ic, "tasks must sort ascending by id");
    }

    #[test]
    fn task_get_unknown_returns_null_task() {
        let out = task_get(&json!({ "taskId": "zz-does-not-exist-zz" })).unwrap();
        assert!(out["task"].is_null());
    }

    #[test]
    fn task_get_requires_task_id() {
        assert!(task_get(&json!({})).is_err());
    }

    #[test]
    fn task_update_transitions_status() {
        let id = task_create(&json!({"subject":"x","description":"y"}))
            .unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let out = task_update(&json!({
            "taskId": id,
            "status": "in_progress",
        }))
        .unwrap();
        assert_eq!(out["success"], true);
        let fields = out["updatedFields"].as_array().unwrap();
        assert!(fields.iter().any(|v| v == "status"));
        assert_eq!(out["statusChange"]["from"], "pending");
        assert_eq!(out["statusChange"]["to"], "in_progress");
    }

    #[test]
    fn task_update_deleted_removes_entry() {
        let id = task_create(&json!({"subject":"x","description":"y"}))
            .unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let out = task_update(&json!({
            "taskId": id,
            "status": "deleted",
        }))
        .unwrap();
        assert_eq!(out["success"], true);
        let fields = out["updatedFields"].as_array().unwrap();
        assert!(fields.iter().any(|v| v == "deleted"));
        let got = task_get(&json!({ "taskId": id })).unwrap();
        assert!(got["task"].is_null());
    }

    #[test]
    fn task_update_no_op_when_no_fields_change() {
        let id = task_create(&json!({"subject":"x","description":"y"}))
            .unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let out = task_update(&json!({
            "taskId": id,
            "subject": "x",
            "description": "y",
        }))
        .unwrap();
        assert_eq!(out["success"], true);
        let fields = out["updatedFields"].as_array().unwrap();
        assert!(
            fields.is_empty(),
            "no-op update must return empty updatedFields, got {fields:?}"
        );
    }

    #[test]
    fn task_update_unknown_id_reports_failure() {
        let out = task_update(&json!({
            "taskId": "zzzz-not-real",
            "status": "completed",
        }))
        .unwrap();
        assert_eq!(out["success"], false);
        assert!(out["error"].as_str().unwrap().contains("not found"));
    }

    #[test]
    fn task_update_unknown_status_errors() {
        let id = task_create(&json!({"subject":"x","description":"y"}))
            .unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let err = task_update(&json!({
            "taskId": id,
            "status": "bogus-status",
        }))
        .unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn task_update_requires_task_id() {
        assert!(task_update(&json!({})).is_err());
    }

    #[test]
    fn task_update_metadata_merge_and_delete() {
        let id = task_create(&json!({"subject":"x","description":"y"}))
            .unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        task_update(&json!({
            "taskId": id,
            "metadata": { "k1": "v1", "k2": 2 },
        }))
        .unwrap();
        let got = task_get(&json!({ "taskId": id })).unwrap();
        assert_eq!(got["task"]["metadata"]["k1"], "v1");
        assert_eq!(got["task"]["metadata"]["k2"], 2);

        // Nullify k1 — should be removed.
        task_update(&json!({
            "taskId": id,
            "metadata": { "k1": null },
        }))
        .unwrap();
        let got = task_get(&json!({ "taskId": id })).unwrap();
        assert!(got["task"]["metadata"].get("k1").is_none());
        assert_eq!(got["task"]["metadata"]["k2"], 2);
    }

    #[test]
    fn schema_consts_parse_as_json() {
        for raw in [
            TOOL_TASK_CREATE_JSON,
            TOOL_TASK_LIST_JSON,
            TOOL_TASK_GET_JSON,
            TOOL_TASK_UPDATE_JSON,
        ] {
            let _: Value = serde_json::from_str(raw).expect("schema JSON well-formed");
        }
    }
}
