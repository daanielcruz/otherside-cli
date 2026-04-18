//! Build the `system[]` array of the outbound request body.
//!
//! Four blocks in capture-observed order:
//! 0. billing header (`x-anthropic-billing-header: cc_version=...`)
//! 1. "You are Claude Code..." opener
//! 2. longer pre-prompt block ("You are an interactive agent...")
//! 3. the ~16KB main agent system prompt
//!
//! Preamble (blocks 0..=2) is stored as a single JSON array in
//! `system-preamble.json`. Main prompt (block 3) is a plain text file
//! `system-prompt.md`. This builder stitches them into one
//! `Vec<serde_json::Value>` ready to splice.
//!
//! None of the four system blocks carry a `cache_control` marker in the
//! captured body — verified by inspection of
//! `fingerprint_corpus/tools-glob-single/turn1/request.body.json`.
//! (Any cache discipline lives on the `messages[]` tail per R-53 as
//! revised by change 009.)

use serde_json::{json, Value};

use super::{SYSTEM_PREAMBLE_JSON, SYSTEM_PROMPT};

/// Assemble the 4-block `system[]` array. Byte-verbatim reproduction of
/// the captured slice when compared as parsed JSON values.
pub fn build_system_blocks() -> Vec<Value> {
    let preamble: Value = serde_json::from_str(SYSTEM_PREAMBLE_JSON)
        .expect("bundled system-preamble.json is well-formed");
    let mut blocks: Vec<Value> = preamble
        .as_array()
        .expect("system-preamble.json top-level is an array")
        .clone();
    blocks.push(json!({
        "type": "text",
        "text": SYSTEM_PROMPT,
    }));
    blocks
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
