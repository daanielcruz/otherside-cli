

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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    AssistantMessage {
        ts: Timestamp,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    ToolCall {
        ts: Timestamp,
        tool_name: String,
        args: Value,
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
}

impl Record {

    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn user_message(ts: impl Into<String>, content: impl Into<String>) -> Self {
        Self::UserMessage {
            ts: ts.into(),
            content: content.into(),
            provider: None,
            model: None,
        }
    }

    pub fn assistant_message(ts: impl Into<String>, content: impl Into<String>) -> Self {
        Self::AssistantMessage {
            ts: ts.into(),
            content: content.into(),
            thinking: None,
            usage: None,
            provider: None,
            model: None,
        }
    }

    pub fn tool_call(
        ts: impl Into<String>,
        tool_name: impl Into<String>,
        args: Value,
        call_id: impl Into<String>,
    ) -> Self {
        Self::ToolCall {
            ts: ts.into(),
            tool_name: tool_name.into(),
            args,
            call_id: call_id.into(),
            provider: None,
            model: None,
        }
    }

    pub fn compaction_mark(ts: impl Into<String>, summary_ref: impl Into<String>) -> Self {
        Self::CompactionMark {
            ts: ts.into(),
            summary_ref: summary_ref.into(),
            provider: None,
            model: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn user_message_round_trip() {
        let rec = Record::user_message("2026-04-18T12:00:00.000Z", "hello");
        let line = rec.to_line();
        let parsed: Record = serde_json::from_str(&line).unwrap();
        assert_eq!(rec, parsed);
    }

    #[test]
    fn user_message_carries_provider_and_model_when_set() {
        let rec = Record::UserMessage {
            ts: "2026-04-18T12:00:00.000Z".into(),
            content: "hello".into(),
            provider: Some("anthropic-oauth".into()),
            model: Some("claude-opus-4-7[1m]".into()),
        };
        let line = rec.to_line();
        assert!(line.contains("\"provider\":\"anthropic-oauth\""));
        assert!(line.contains("\"model\":\"claude-opus-4-7[1m]\""));
    }

    #[test]
    fn legacy_records_without_provider_model_still_parse() {
        let legacy = r#"{"type":"user_message","ts":"2026-04-18T12:00:00.000Z","content":"hi"}"#;
        let parsed: Record = serde_json::from_str(legacy).expect("legacy records parse");
        let Record::UserMessage { provider, model, .. } = parsed else {
            panic!("expected UserMessage");
        };
        assert!(provider.is_none());
        assert!(model.is_none());
    }

    #[test]
    fn tool_call_preserves_name_anchor() {

        let rec = Record::tool_call(
            "2026-04-18T12:00:00.000Z",
            "Bash",
            json!({"command": "ls"}),
            "tu_1",
        );
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
        let rec = Record::compaction_mark("2026-04-18T12:00:00.000Z", "abc123");
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
