

use serde_json::{json, Value};

use crate::harness::{SYSTEM_AGENT_PREAMBLE, SYSTEM_BILLING_HEADER, SYSTEM_OPENER, SYSTEM_PROMPT};

fn cache_ephemeral_1h_global() -> Value {
    json!({"type": "ephemeral", "ttl": "1h"})
}

fn text_block(text: &str) -> Value {
    json!({"type": "text", "text": text})
}

fn text_block_cached(text: &str) -> Value {
    json!({
        "type": "text",
        "text": text,
        "cache_control": cache_ephemeral_1h_global(),
    })
}

pub fn build_system_blocks() -> Vec<Value> {
    vec![
        text_block(SYSTEM_BILLING_HEADER),
        text_block(SYSTEM_OPENER),
        text_block_cached(SYSTEM_AGENT_PREAMBLE),
        text_block(SYSTEM_PROMPT),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_four_blocks() {
        let blocks = build_system_blocks();
        assert_eq!(blocks.len(), 4);
    }

    #[test]
    fn last_block_is_main_system_prompt() {
        let blocks = build_system_blocks();
        let last = blocks.last().unwrap();
        assert_eq!(last["type"], "text");
        assert!(
            last["text"].as_str().unwrap().len() > 15000,
            "system[3] must be the ~16KB main agent prompt"
        );
    }

    #[test]
    fn first_block_is_billing_header() {
        let blocks = build_system_blocks();
        let first = &blocks[0];
        assert_eq!(first["type"], "text");
        assert!(
            first["text"]
                .as_str()
                .unwrap()
                .starts_with("x-anthropic-billing-header:"),
            "system[0] must be the billing header"
        );
    }
}
