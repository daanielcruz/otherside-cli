

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Timestamp = String;

pub fn now_iso() -> Timestamp {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Record {
    UserMessage {
        ts: Timestamp,
        content: String,
    },
    AssistantMessage {
        ts: Timestamp,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Value>,
    },
    ToolCall {
        ts: Timestamp,
        tool_name: String,
        args: Value,
        call_id: String,
    },
    ToolResult {
        ts: Timestamp,
        call_id: String,
        result: Value,
        is_error: bool,
    },
    HookEvent {
        ts: Timestamp,
        kind: String,
        payload: Value,
    },
    CompactionMark {
        ts: Timestamp,
        summary_ref: String,
    },
}

impl Record {

    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn user_message_round_trip() {
        let rec = Record::UserMessage {
            ts: "2026-04-18T12:00:00.000Z".into(),
            content: "hello".into(),
        };
        let line = rec.to_line();
        let parsed: Record = serde_json::from_str(&line).unwrap();
        assert_eq!(rec, parsed);
    }

    #[test]
    fn tool_call_preserves_name_anchor() {

        let rec = Record::ToolCall {
            ts: "2026-04-18T12:00:00.000Z".into(),
            tool_name: "Bash".into(),
            args: json!({"command": "ls"}),
            call_id: "tu_1".into(),
        };
        let line = rec.to_line();
        assert!(line.contains("\"tool_name\":\"Bash\""));
        assert!(!line.to_lowercase().contains("\"bash\"") || line.contains("\"Bash\""));
    }

    #[test]
    fn tool_result_carries_is_error_flag() {
        let rec = Record::ToolResult {
            ts: "2026-04-18T12:00:00.000Z".into(),
            call_id: "tu_1".into(),
            result: json!({"output": "error: boom"}),
            is_error: true,
        };
        let line = rec.to_line();
        assert!(line.contains("\"is_error\":true"));
    }

    #[test]
    fn compaction_mark_round_trip() {
        let rec = Record::CompactionMark {
            ts: "2026-04-18T12:00:00.000Z".into(),
            summary_ref: "abc123".into(),
        };
        let line = rec.to_line();
        let parsed: Record = serde_json::from_str(&line).unwrap();
        assert_eq!(rec, parsed);
    }

    #[test]
    fn now_iso_has_expected_shape() {
        let ts = now_iso();
        assert!(ts.ends_with('Z'));

        assert_eq!(ts.len(), 24);
    }
}
