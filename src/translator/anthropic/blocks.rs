

use serde_json::{json, Map, Value};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheControl;

impl CacheControl {
    pub fn to_json(self) -> Value {
        json!({ "type": "ephemeral", "ttl": "1h" })
    }
}

#[derive(Debug, Clone)]
pub enum Block {

    Text {
        text: String,
        cache_control: Option<CacheControl>,
    },

    ToolUse {
        id: String,
        name: String,
        input: Value,
    },

    ToolResult {
        tool_use_id: String,
        content: String,
        cache_control: Option<CacheControl>,
    },

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

    #[test]
    fn anthropic_message_emits_thinking_block_before_tool_use_when_present() {
        // kimi round-trip: when captured thinking + signature rides on
        // the assistant turn, the next request body must start content
        // with `{"type":"thinking",...}` BEFORE any `tool_use`. No
        // top-level `reasoning_content` sibling — kimi-cli reference
        // pattern.
        let m = AnthropicMessage {
            role: Role::Assistant,
            content: vec![
                Block::Thinking {
                    thinking: "Let me think.".into(),
                    signature: "sig-abc".into(),
                },
                Block::ToolUse {
                    id: "tu".into(),
                    name: "Glob".into(),
                    input: json!({}),
                },
            ],
        };
        let v = m.to_json();
        let arr = v["content"].as_array().unwrap();
        assert_eq!(arr[0]["type"], "thinking");
        assert_eq!(arr[0]["thinking"], "Let me think.");
        assert_eq!(arr[0]["signature"], "sig-abc");
        assert_eq!(arr[1]["type"], "tool_use");
        assert!(
            v.get("reasoning_content").is_none(),
            "no top-level reasoning_content sibling — kimi-cli wire",
        );
    }
}
