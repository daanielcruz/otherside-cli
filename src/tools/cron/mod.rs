use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::tools::ToolError;

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

pub const TOOL_CRON_CREATE_JSON: &str =
    include_str!("../../../harness_corpus/tools/CronCreate.json");

pub const TOOL_CRON_DELETE_JSON: &str =
    include_str!("../../../harness_corpus/tools/CronDelete.json");

pub const TOOL_CRON_LIST_JSON: &str =
    include_str!("../../../harness_corpus/tools/CronList.json");

pub const TOOL_SCHEDULE_WAKEUP_JSON: &str =
    include_str!("../../../harness_corpus/tools/ScheduleWakeup.json");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_interval_units() {
        assert_eq!(parse_interval("30s"), Some(30_000));
        assert_eq!(parse_interval("5m"), Some(300_000));
        assert_eq!(parse_interval("2h"), Some(7_200_000));
        assert_eq!(parse_interval("5"), Some(300_000));
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
        let del2 = cron_delete(&json!({ "id": &id })).unwrap();
        assert_eq!(del2["deleted"], false);
    }

    #[test]
    fn cron_create_requires_prompt() {
        assert!(cron_create(&json!({})).is_err());
    }

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
        assert!(still_pending.is_empty());
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
        assert!(due.iter().any(|w| w.message == "overdue-unique-token"));
        let second = drain_due_wakeups();
        assert!(!second.iter().any(|w| w.message == "overdue-unique-token"));
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
    fn schemas_parse_as_json() {
        for raw in [
            TOOL_CRON_CREATE_JSON,
            TOOL_CRON_DELETE_JSON,
            TOOL_CRON_LIST_JSON,
            TOOL_SCHEDULE_WAKEUP_JSON,
        ] {
            let _: Value = serde_json::from_str(raw).unwrap();
        }
    }
}
