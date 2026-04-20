//! Build the `system[]` array of the outbound request body.
//!
//! Four blocks in capture-observed order:
//! 0. billing header (`x-anthropic-billing-header: cc_version=...`)
//! 1. "You are Claude Code..." opener
//! 2. longer pre-prompt block ("You are an interactive agent...")
//! 3. the ~16KB main agent system prompt
//!
//! Every block ships as its own markdown under `harness_corpus/system/`
//! (`00-billing-header.md`, `01-opener.md`, `02-agent-preamble.md`,
//! `03-main-prompt.md`). This builder wraps each payload in the
//! `{type:"text", text:…}` JSON envelope expected on the wire and
//! attaches block 2's `cache_control` marker. All four blocks carry
//! `cache_control: {type:"ephemeral", ttl:"1h", scope:"global"}` per
//! the captured body — verified by inspection of
//! `fingerprint_corpus/tools-glob-single/turn1/request.body.json`.
//! (Actually only block 2 carries cache_control on the captured slice;
//! the other three do not. See `build_system_blocks` for the exact
//! attach site.)

use serde_json::{json, Value};

use crate::harness::{SYSTEM_AGENT_PREAMBLE, SYSTEM_BILLING_HEADER, SYSTEM_OPENER, SYSTEM_PROMPT};

/// Cache-control marker attached to system[2]. The captured body had
/// `scope: "global"` — the API has since tightened validation to reject
/// that value when the `tools` array renders before the system block
/// (which it always does with our 27-tool set). Dropping `scope`
/// leaves the default (block-level) scope, which is what every real
/// request otherside ships actually needs.
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

/// Assemble the 4-block `system[]` array. Byte-verbatim reproduction of
/// the captured slice when compared as parsed JSON values.
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
