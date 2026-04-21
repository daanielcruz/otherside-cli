

pub mod model_display;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct OpenAiChatRequest {
    pub model: String,

    pub messages: Vec<OpenAiChatMessage>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<OpenAiToolDef>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<serde_json::Value>,

    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenAiToolDef {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: OpenAiFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenAiFunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: OpenAiToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiToolCallFunction {
    pub name: String,

    pub arguments: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiChatMessage {
    pub role: OpenAiChatRole,
    pub content: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<OpenAiToolCall>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OpenAiChatRole {
    System,
    #[default]
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenAiChunk {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<OpenAiChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<OpenAiUsage>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenAiChoice {
    pub index: u32,
    pub delta: OpenAiDelta,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<OpenAiChatRole>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<OpenAiToolCallDelta>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiToolCallDelta {
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<OpenAiToolCallFunctionDelta>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiToolCallFunctionDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
}

impl OpenAiChunk {

    pub const OBJECT: &'static str = "chat.completion.chunk";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiChatCompletion {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<OpenAiChatCompletionChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiChatCompletionChoice {
    pub index: u32,
    pub message: OpenAiChatMessage,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

impl OpenAiChatCompletion {

    pub const OBJECT: &'static str = "chat.completion";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_request_round_trip() {
        let req = OpenAiChatRequest {
            model: "claude-opus-4-7".to_string(),
            messages: vec![OpenAiChatMessage {
                role: OpenAiChatRole::User,
                content: "hi".to_string(),
                ..Default::default()
            }],
            stream: Some(true),
            max_tokens: Some(1024),
            ..Default::default()
        };

        let json = serde_json::to_string(&req).unwrap();
        let round: OpenAiChatRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, round);
    }

    #[test]
    fn optional_none_fields_are_omitted() {
        let req = OpenAiChatRequest {
            model: "m".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.get("temperature").is_none());
        assert!(json.get("top_p").is_none());
        assert!(json.get("stream").is_none());
    }

    #[test]
    fn extra_fields_pass_through() {

        let raw = r#"{
            "model":"gpt-5",
            "messages":[{"role":"user","content":"hi"}],
            "reasoning":{"effort":"high"}
        }"#;
        let req: OpenAiChatRequest = serde_json::from_str(raw).unwrap();
        assert!(req.extra.contains_key("reasoning"));
    }

    #[test]
    fn role_serializes_lowercase() {
        let msg = OpenAiChatMessage {
            role: OpenAiChatRole::Assistant,
            content: "".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"role\":\"assistant\""));
    }

    #[test]
    fn chunk_shape() {
        let chunk = OpenAiChunk {
            id: "chatcmpl-1".to_string(),
            object: OpenAiChunk::OBJECT.to_string(),
            created: 1700000000,
            model: "claude-opus-4-7".to_string(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    role: Some(OpenAiChatRole::Assistant),
                    content: Some("Hi".to_string()),
                    tool_calls: Vec::new(),
                },
                finish_reason: None,
            }],
            usage: None,
        };
        let json = serde_json::to_string(&chunk).unwrap();

        assert!(json.contains("\"object\":\"chat.completion.chunk\""));
        assert!(json.contains("\"delta\""));
        assert!(json.contains("\"role\":\"assistant\""));
    }
}
