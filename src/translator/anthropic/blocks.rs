//! Anthropic content-block shapes and per-variant JSON emitters.
//!
//! Emitted key order per variant matches the captured wire bytes exactly.
//! Notable: `tool_result` carries `tool_use_id` BEFORE `type`, which is
//! unusual JSON tooling order but matches every captured outbound body.
//! `serde_json::Map` insertion order (with the `preserve_order` feature
//! enabled crate-wide) is honored on serialization.

use serde_json::{json, Map, Value};

/// Message-level role for the Anthropic wire. On wire these are the
/// lowercase strings `"user"` / `"assistant"` (per R-21). System content
/// is not a message role in Anthropic — it travels via the envelope's
/// `system[]` top-level field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    pub fn wire(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

/// Cache-control marker. Exactly one instance is attached to the last
/// content block of the last message in an outbound body (revised R-53,
/// per change 009).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheControl;

impl CacheControl {
    pub fn to_json(self) -> Value {
        json!({ "type": "ephemeral", "ttl": "1h" })
    }
}

/// One Anthropic content block.
#[derive(Debug, Clone)]
pub enum Block {
    /// `{ "type": "text", "text": "...", "cache_control"?: {...} }`
    Text {
        text: String,
        cache_control: Option<CacheControl>,
    },
    /// `{ "type": "tool_use", "id": ..., "name": ..., "input": {...}, "caller": {"type":"direct"} }`
    ///
    /// `caller` is always emitted with the literal `{"type":"direct"}`;
    /// future subagent-dispatch work will vary this value.
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// `{ "tool_use_id": ..., "type": "tool_result", "content": "...", "cache_control"?: {...} }`
    ///
    /// NB: `tool_use_id` BEFORE `type` — matches capture.
    ToolResult {
        tool_use_id: String,
        content: String,
        cache_control: Option<CacheControl>,
    },
    /// `{ "type": "thinking", "thinking": "...", "signature": "..." }`
    ///
    /// `signature` is server-issued base64. Agent loop replay of signatures
    /// on turn 2+ is deferred to a follow-up change — today the agent may
    /// elide thinking blocks on subsequent turns until signature capture
    /// lands.
    Thinking {
        thinking: String,
        signature: String,
    },
}

impl Block {
    pub fn to_json(&self) -> Value {
        match self {
            Block::Text { text, cache_control } => {
                let mut m = Map::new();
                m.insert("type".into(), Value::String("text".into()));
                m.insert("text".into(), Value::String(text.clone()));
                if let Some(cc) = cache_control {
                    m.insert("cache_control".into(), cc.to_json());
                }
                Value::Object(m)
            }
            Block::ToolUse { id, name, input } => {
                let mut m = Map::new();
                m.insert("type".into(), Value::String("tool_use".into()));
                m.insert("id".into(), Value::String(id.clone()));
                m.insert("name".into(), Value::String(name.clone()));
                m.insert("input".into(), input.clone());
                m.insert("caller".into(), json!({ "type": "direct" }));
                Value::Object(m)
            }
            Block::ToolResult {
                tool_use_id,
                content,
                cache_control,
            } => {
                let mut m = Map::new();
                m.insert("tool_use_id".into(), Value::String(tool_use_id.clone()));
                m.insert("type".into(), Value::String("tool_result".into()));
                m.insert("content".into(), Value::String(content.clone()));
                if let Some(cc) = cache_control {
                    m.insert("cache_control".into(), cc.to_json());
                }
                Value::Object(m)
            }
            Block::Thinking { thinking, signature } => {
                let mut m = Map::new();
                m.insert("type".into(), Value::String("thinking".into()));
                m.insert("thinking".into(), Value::String(thinking.clone()));
                m.insert("signature".into(), Value::String(signature.clone()));
                Value::Object(m)
            }
        }
    }

    /// Attach a cache-control marker to this block. Only Text and
    /// ToolResult variants carry cache_control on the wire.
    pub fn attach_cache_control(&mut self) {
        match self {
            Block::Text { cache_control, .. } => *cache_control = Some(CacheControl),
            Block::ToolResult { cache_control, .. } => *cache_control = Some(CacheControl),
            Block::ToolUse { .. } | Block::Thinking { .. } => {
                tracing::error!(
                    "attempted to attach cache_control to a ToolUse / Thinking block; these do not carry the marker in capture — skipping"
                );
            }
        }
    }
}

/// Anthropic message — role + content blocks.
#[derive(Debug, Clone)]
pub struct AnthropicMessage {
    pub role: Role,
    pub content: Vec<Block>,
}

impl AnthropicMessage {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("role".into(), Value::String(self.role.wire().into()));
        let arr: Vec<Value> = self.content.iter().map(|b| b.to_json()).collect();
        m.insert("content".into(), Value::Array(arr));
        Value::Object(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn role_wire_is_lowercase() {
        assert_eq!(Role::User.wire(), "user");
        assert_eq!(Role::Assistant.wire(), "assistant");
    }

    #[test]
    fn text_block_emits_type_text_order() {
        let b = Block::Text {
            text: "hi".into(),
            cache_control: None,
        };
        let v = b.to_json();
        assert_eq!(v["type"], "text");
        assert_eq!(v["text"], "hi");
        assert!(v.get("cache_control").is_none());
    }

    #[test]
    fn text_block_cache_control_is_last() {
        let b = Block::Text {
            text: "x".into(),
            cache_control: Some(CacheControl),
        };
        let v = b.to_json();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        assert_eq!(keys, vec!["type", "text", "cache_control"]);
        assert_eq!(v["cache_control"]["type"], "ephemeral");
        assert_eq!(v["cache_control"]["ttl"], "1h");
    }

    #[test]
    fn tool_use_block_emits_capture_key_order() {
        let b = Block::ToolUse {
            id: "toolu_abc".into(),
            name: "Glob".into(),
            input: json!({ "pattern": "src/*.rs" }),
        };
        let v = b.to_json();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        assert_eq!(keys, vec!["type", "id", "name", "input", "caller"]);
        assert_eq!(v["caller"]["type"], "direct");
    }

    #[test]
    fn tool_result_block_emits_tool_use_id_before_type() {
        // The unusual key order from capture.
        let b = Block::ToolResult {
            tool_use_id: "toolu_abc".into(),
            content: "out".into(),
            cache_control: None,
        };
        let v = b.to_json();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        assert_eq!(keys, vec!["tool_use_id", "type", "content"]);
    }

    #[test]
    fn tool_result_block_with_cache_control_keeps_order() {
        let b = Block::ToolResult {
            tool_use_id: "toolu_abc".into(),
            content: "out".into(),
            cache_control: Some(CacheControl),
        };
        let v = b.to_json();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        assert_eq!(keys, vec!["tool_use_id", "type", "content", "cache_control"]);
    }

    #[test]
    fn thinking_block_emits_capture_key_order() {
        let b = Block::Thinking {
            thinking: "".into(),
            signature: "sig".into(),
        };
        let v = b.to_json();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        assert_eq!(keys, vec!["type", "thinking", "signature"]);
    }

    #[test]
    fn attach_cache_control_on_text() {
        let mut b = Block::Text {
            text: "x".into(),
            cache_control: None,
        };
        b.attach_cache_control();
        let v = b.to_json();
        assert!(v.get("cache_control").is_some());
    }

    #[test]
    fn attach_cache_control_on_tool_result() {
        let mut b = Block::ToolResult {
            tool_use_id: "t".into(),
            content: "c".into(),
            cache_control: None,
        };
        b.attach_cache_control();
        let v = b.to_json();
        assert!(v.get("cache_control").is_some());
    }

    #[test]
    fn attach_cache_control_on_tool_use_is_noop() {
        let mut b = Block::ToolUse {
            id: "t".into(),
            name: "Glob".into(),
            input: json!({}),
        };
        b.attach_cache_control();
        let v = b.to_json();
        assert!(v.get("cache_control").is_none());
    }

    #[test]
    fn anthropic_message_emits_role_first() {
        let m = AnthropicMessage {
            role: Role::User,
            content: vec![Block::Text {
                text: "x".into(),
                cache_control: None,
            }],
        };
        let v = m.to_json();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        assert_eq!(keys, vec!["role", "content"]);
        assert_eq!(v["role"], "user");
    }
}
