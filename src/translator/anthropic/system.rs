

use serde_json::{json, Value};

use crate::harness::{SYSTEM_AGENT_PREAMBLE, SYSTEM_BILLING_HEADER, SYSTEM_OPENER, SYSTEM_PROMPT};

/// Which provider flavor is building the system prompt. Controls whether
/// claude-code-exclusive blocks (billing header + opener identity) land.
///
/// - `ClaudeCode`: all four blocks — billing header, `You are Claude Code…`
///   opener, agent preamble (cached), main system prompt.
/// - `ThirdParty`: skip billing + opener. Kimi and Codex go here — the
///   agent preamble + main system prompt still flow so tools, slash
///   commands, memory system, and every operational instruction land
///   upstream-identical; only the claude-code-routing string and the
///   claude-identity one-liner are elided.
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

    #[test]
    fn third_party_flavor_drops_billing_header_and_opener() {
        // Kimi/Codex must NOT receive the `x-anthropic-billing-header:`
        // routing string nor the `You are Claude Code…` claude-identity
        // opener — those are first-party-only. Agent preamble + main
        // prompt still ride so every operational instruction lands.
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
    fn claude_code_flavor_still_includes_billing_and_opener() {
        // Regression: the split must NOT change the claude-code wire.
        let blocks = build_system_blocks_for(SystemFlavor::ClaudeCode);
        assert_eq!(blocks.len(), 4);
        assert!(blocks[0]["text"].as_str().unwrap().starts_with("x-anthropic-billing-header:"));
        assert!(blocks[1]["text"].as_str().unwrap().starts_with("You are Claude Code,"));
    }

    #[test]
    fn both_flavors_share_the_preamble_and_main_prompt_content() {
        // The operational blocks are IDENTICAL across flavors — only the
        // first-party header + opener differ.
        let cc = build_system_blocks_for(SystemFlavor::ClaudeCode);
        let tp = build_system_blocks_for(SystemFlavor::ThirdParty);
        assert_eq!(cc[2]["text"], tp[0]["text"], "agent preamble must match");
        assert_eq!(cc[3]["text"], tp[1]["text"], "main prompt must match");
    }
}
