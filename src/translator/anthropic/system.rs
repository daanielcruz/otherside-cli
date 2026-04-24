
use serde_json::{json, Value};

use crate::harness::{SYSTEM_AGENT_PREAMBLE, SYSTEM_BILLING_HEADER, SYSTEM_OPENER, SYSTEM_PROMPT};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemFlavor {
    ClaudeCode,
    ThirdParty,
}

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
    build_system_blocks_for(SystemFlavor::ClaudeCode)
}

pub fn build_system_blocks_for(flavor: SystemFlavor) -> Vec<Value> {
    match flavor {
        SystemFlavor::ClaudeCode => vec![
            text_block(SYSTEM_BILLING_HEADER),
            text_block(SYSTEM_OPENER),
            text_block_cached(SYSTEM_AGENT_PREAMBLE),
            text_block(SYSTEM_PROMPT),
        ],
        SystemFlavor::ThirdParty => vec![
            text_block_cached(SYSTEM_AGENT_PREAMBLE),
            text_block(SYSTEM_PROMPT),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn third_party_flavor_drops_billing_header_and_opener() {
        
        let blocks = build_system_blocks_for(SystemFlavor::ThirdParty);
        assert_eq!(blocks.len(), 2, "third-party keeps preamble + main only");
        let texts: Vec<&str> = blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect();
        for t in &texts {
            assert!(
                !t.contains("x-anthropic-billing-header:"),
                "billing header leaked into third-party system: {t}",
            );
            assert!(
                !t.starts_with("You are Claude Code,"),
                "claude-code opener leaked into third-party system: {t}",
            );
        }
        assert!(
            texts.last().unwrap().len() > 15_000,
            "main system prompt (~16KB) still rides under third-party"
        );
    }

    #[test]
    fn claude_code_flavor_ships_four_blocks_with_billing_and_main_prompt() {
        let blocks = build_system_blocks_for(SystemFlavor::ClaudeCode);
        assert_eq!(blocks.len(), 4);
        assert!(blocks[0]["text"].as_str().unwrap().starts_with("x-anthropic-billing-header:"));
        assert!(blocks[1]["text"].as_str().unwrap().starts_with("You are Claude Code,"));
        assert!(
            blocks[3]["text"].as_str().unwrap().len() > 15_000,
            "system[3] must be the ~16KB main agent prompt"
        );
    }

    #[test]
    fn both_flavors_share_the_preamble_and_main_prompt_content() {
        
        let cc = build_system_blocks_for(SystemFlavor::ClaudeCode);
        let tp = build_system_blocks_for(SystemFlavor::ThirdParty);
        assert_eq!(cc[2]["text"], tp[0]["text"], "agent preamble must match");
        assert_eq!(cc[3]["text"], tp[1]["text"], "main prompt must match");
    }
}
