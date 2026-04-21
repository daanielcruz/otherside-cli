

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Map, Value};

use crate::tools::ToolError;

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

fn registry() -> &'static Mutex<HashMap<String, Task>> {
    static TASK_REGISTRY: OnceLock<Mutex<HashMap<String, Task>>> = OnceLock::new();
    TASK_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

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

pub fn task_update(args: &Value) -> Result<Value, ToolError> {
    let task_id = require_str(args, "taskId")?.to_string();

    let mut guard = registry()
        .lock()
        .map_err(|e| ToolError::InvalidArgs(format!("registry lock poisoned: {e}")))?;

    if let Some(status) = args.get("status").and_then(Value::as_str) {
        if status == "deleted" {
            let existed = guard.remove(&task_id).is_some();
            let from_status = if existed { "pending" } else { "unknown" };

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

#[cfg(test)]
pub fn clear_registry() {
    if let Ok(mut guard) = registry().lock() {
        guard.clear();
    }
}

pub const TOOL_TASK_CREATE_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskCreate.json");

pub const TOOL_TASK_LIST_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskList.json");

pub const TOOL_TASK_GET_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskGet.json");

pub const TOOL_TASK_UPDATE_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskUpdate.json");

pub const TOOL_TASK_OUTPUT_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskOutput.json");

pub const TOOL_TASK_STOP_JSON: &str =
    include_str!("../../../harness_corpus/tools/TaskStop.json");

pub fn task_output(args: &Value) -> Result<Value, ToolError> {
    let task_id = args
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("`taskId` is required".into()))?;
    if let Some(store) = crate::tasks::store::current_global() {
        let bg_id = crate::tasks::TaskId::from_string(task_id.to_string());
        if let Some(record) = store.get(&bg_id) {
            let status_str = match record.state {
                crate::tasks::TaskState::Pending => "pending",
                crate::tasks::TaskState::Running => "running",
                crate::tasks::TaskState::Backgrounded => "backgrounded",
                crate::tasks::TaskState::Completed => "completed",
                crate::tasks::TaskState::Failed => "failed",
                crate::tasks::TaskState::Stopped => "stopped",
            };
            let output = if record.output.is_empty() {
                String::new()
            } else {
                record.output.iter().cloned().collect::<Vec<_>>().join("\n")
            };
            return Ok(json!({
                "taskId": task_id,
                "status": status_str,
                "output": output,
                "tool_use_id": record.tool_use_id,
                "exit_code": record.exit_code,
            }));
        }
    }
    let got = task_get(&json!({ "taskId": task_id }))?;
    if got["task"].is_null() {
        return Ok(json!({
            "taskId": task_id,
            "output": null,
            "error": "task not found",
        }));
    }
    let task = &got["task"];
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
    let out = task_update(&json!({
        "taskId": task_id,
        "status": "cancelled",
    }))?;
    Ok(json!({
        "taskId": task_id,
        "success": out["success"].clone(),
        "statusChange": out["statusChange"].clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_registry() {
        clear_registry();

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
