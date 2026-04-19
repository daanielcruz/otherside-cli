//! Canonical OpenAI-shaped request and event types.
//!
//! The agent layer speaks only these shapes. Providers translate to/from
//! native formats via `src/translator/`. This module owns the canonical
//! types — it does NOT do HTTP; HTTP lives in `provider::*`.
//!
//! # Why OpenAI as the internal canonical shape (C11)
//!
//! - `otherside serve` exposes `/v1/chat/completions` — if that's also our
//!   canonical, the server is nearly free (identity translator).
//! - OpenAI's shape is the widest-supported client format.
//! - CLIProxyAPI uses the same approach — borrowed convention.
//!
//! # Canonical scope
//!
//! Messages carry `content: String` for text. Tool calls on the assistant
//! side use the OpenAI-shape `tool_calls` field; tool results come back as
//! `role: "tool"` messages with a `tool_call_id` reference. Multimodal
//! content blocks are still deferred.
//!
//! # Out of scope for these types
//!
//! - Thinking / reasoning is NOT a field on the canonical request. Intent
//!   is carried via the model-name suffix (C12) and resolved by the router
//!   into a [`crate::thinking::ThinkingConfig`] that travels alongside the
//!   request through the translator.

pub mod model_display;

use serde::{Deserialize, Serialize};

/// Canonical OpenAI chat completions request.
///
/// The agent layer emits this and hands it to a [`crate::provider::Provider`].
/// The provider calls through the translator matrix to convert to native
/// format before issuing HTTP.
///
/// `#[serde(skip_serializing_if = "Option::is_none")]` is applied to every
/// optional field so we don't emit `null`s — matches OpenAI's documented
/// wire format and avoids gratuitous key divergence when the agent emits
/// only a subset.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct OpenAiChatRequest {
    pub model: String,

    pub messages: Vec<OpenAiChatMessage>,

    /// When `true`, the provider MUST return an SSE stream of
    /// [`OpenAiChunk`] events. When `false` or missing, the provider MUST
    /// return a single aggregate response (not implemented in MVP).
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

    /// OpenAI-shape tool catalog the model may call. Translator maps this
    /// onto each provider's native tools surface (Anthropic `tools` array).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<OpenAiToolDef>,

    /// How the model chooses whether to call tools. `auto` / `none` / an
    /// explicit `{type:"function", function:{name:"..."}}` forcing a call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<serde_json::Value>,

    /// Additional fields that a client may set (e.g. `reasoning.effort` from
    /// OpenAI spec). Accepted for compatibility; the router's suffix-parsed
    /// thinking config takes priority per C12.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// OpenAI function-calling tool definition. Serialized as
/// `{ "type": "function", "function": { "name", "description", "parameters" } }`
/// on the wire.
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

/// A single tool call emitted by the assistant. Multiple calls may be
/// batched in one message.
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
    /// JSON-string payload of arguments (OpenAI's design — args are
    /// stringified JSON on the wire, not an object).
    pub arguments: String,
}

/// A chat message. Content is a plain String; tool-role messages carry
/// the result payload in `content` as a stringified blob (matches OpenAI
/// wire format).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiChatMessage {
    pub role: OpenAiChatRole,
    pub content: String,

    /// Optional name disambiguator (OpenAI allows this for `user` and
    /// `function` roles). Rarely used by our agent; kept for parity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Set on assistant messages that emitted tool calls.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<OpenAiToolCall>,

    /// Set on `role: "tool"` messages to reference the call this result
    /// answers (mirrors OpenAI's wire format).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// OpenAI chat completion roles.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OpenAiChatRole {
    System,
    #[default]
    User,
    Assistant,
    Tool,
}

/// Streaming event — one item in the response stream.
///
/// Wire format matches OpenAI's `chat.completion.chunk`. The translator
/// produces these from Anthropic's (or any other provider's) native SSE
/// events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenAiChunk {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenAiChoice {
    pub index: u32,
    pub delta: OpenAiDelta,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

/// The streaming delta emitted on each chunk.
///
/// On the first chunk, `role` is set to `Assistant` and `content` is
/// usually empty. Subsequent chunks carry `content` text deltas OR
/// `tool_calls` deltas (partial name / arguments-string accumulation).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<OpenAiChatRole>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,

    /// Per-call streaming deltas. Each entry has `index` + whatever
    /// fragment of `function.arguments` / `function.name` this chunk
    /// carries — the aggregator on the consumer side concatenates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<OpenAiToolCallDelta>,
}

/// One tool-call fragment inside a streaming delta. OpenAI's shape:
/// every event carries `index` + partial fields; consumers accumulate
/// by index.
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
    /// The `"chat.completion.chunk"` literal required by OpenAI's wire
    /// format.
    pub const OBJECT: &'static str = "chat.completion.chunk";
}

/// Non-streaming completion — returned when the client sets `stream: false`.
///
/// Different object tag (`chat.completion` vs `chat.completion.chunk`) and a
/// single consolidated `message` per choice instead of streamed `delta`s. We
/// build one of these by draining a [`ChunkStream`](crate::provider::ChunkStream)
/// and concatenating all `delta.content` fragments into the final `message`.
///
/// Kept as a sibling of [`OpenAiChunk`] rather than a variant so the serde
/// output of each is minimal — OpenAI's docs treat them as distinct shapes
/// and some client SDKs reject extra fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiChatCompletion {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<OpenAiChatCompletionChoice>,
}

/// A non-streaming choice — complete message plus finish reason.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiChatCompletionChoice {
    pub index: u32,
    pub message: OpenAiChatMessage,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

impl OpenAiChatCompletion {
    /// The `"chat.completion"` literal required by OpenAI's non-streaming
    /// wire format. Distinct from [`OpenAiChunk::OBJECT`] on purpose.
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
        // Reasoning.effort is an extra OpenAI field — ensure we capture it
        // rather than reject.
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
        };
        let json = serde_json::to_string(&chunk).unwrap();
        // Validate wire-format markers that downstream OpenAI clients will
        // look for.
        assert!(json.contains("\"object\":\"chat.completion.chunk\""));
        assert!(json.contains("\"delta\""));
        assert!(json.contains("\"role\":\"assistant\""));
    }
}
