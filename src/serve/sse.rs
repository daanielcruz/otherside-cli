//! OpenAI SSE wire-format encoder.
//!
//! This module is the inverse of `translator::sse` for the server side: it
//! takes canonical [`OpenAiChunk`] values and renders the exact byte sequence
//! OpenAI emits (`data: <json>\n\n`), plus the sentinel terminator
//! (`data: [DONE]\n\n`) that every OpenAI SDK client waits for.
//!
//! Kept as a stand-alone module so it stays trivially unit-testable with
//! byte-exact assertions — none of this touches axum, reqwest, or tokio. If
//! we change the SSE dialect in the future (SSE v2 or a proprietary framing)
//! only this file changes.
//!
//! # Why not `id:` / `event:` fields
//!
//! OpenAI's public SSE traffic uses `data:`-only frames. Clients key off the
//! JSON body and the `[DONE]` sentinel rather than on SSE event names. We
//! match that exactly — emitting an `event:` line would be a divergence some
//! strict SDKs flag as malformed.

use crate::error::{Error, Result};
use crate::inference::OpenAiChunk;

/// Render a single chunk as an SSE `data:` frame terminated by a blank line.
///
/// Returns `Error::Other` if the chunk fails to serialize, which only
/// happens under programmer error (non-string keys in `extra` etc.). The
/// caller should map this to 502 — at that point the upstream translator
/// produced an un-JSON-able value.
pub fn encode_chunk(chunk: &OpenAiChunk) -> Result<String> {
    // Compact JSON on a single line. SSE frames must not contain bare
    // newlines inside `data:` values — `serde_json::to_string` gives us
    // newline-free output by default.
    let json = serde_json::to_string(chunk)
        .map_err(|e| Error::Other(format!("serialize chunk: {e}")))?;
    Ok(format!("data: {json}\n\n"))
}

/// OpenAI's stream terminator. Every compliant client stops reading when it
/// sees this exact frame.
pub const DONE_TERMINATOR: &str = "data: [DONE]\n\n";

/// Borrow the terminator as a string slice. Exposed as a function for
/// symmetry with `encode_chunk` even though the value is a constant — the
/// indirection lets us swap formats without changing call sites.
pub fn done_terminator() -> &'static str {
    DONE_TERMINATOR
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::{OpenAiChatRole, OpenAiChoice, OpenAiDelta};

    fn sample_chunk() -> OpenAiChunk {
        OpenAiChunk {
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
        }
    }

    #[test]
    fn encode_chunk_wraps_in_data_prefix_and_blank_line() {
        let encoded = encode_chunk(&sample_chunk()).unwrap();
        // Prefix is literal "data: " with a single space — strict SSE
        // parsers reject variants.
        assert!(encoded.starts_with("data: "), "got: {encoded:?}");
        // Frame ends with double newline signalling end-of-event.
        assert!(encoded.ends_with("\n\n"), "got: {encoded:?}");
    }

    #[test]
    fn encode_chunk_body_is_valid_openai_json() {
        let encoded = encode_chunk(&sample_chunk()).unwrap();
        // Strip the prefix and trailing blank line, then round-trip as JSON.
        let body = encoded
            .strip_prefix("data: ")
            .and_then(|s| s.strip_suffix("\n\n"))
            .unwrap();
        let back: OpenAiChunk = serde_json::from_str(body).unwrap();
        assert_eq!(back, sample_chunk());
    }

    #[test]
    fn encode_chunk_has_no_internal_newlines_in_data_payload() {
        // Defensive: the JSON body must not contain embedded `\n` — OpenAI
        // clients would interpret those as event separators. This would only
        // trip if we ever enable pretty printing by mistake.
        let encoded = encode_chunk(&sample_chunk()).unwrap();
        let body = encoded.strip_prefix("data: ").unwrap();
        // Exactly one trailing `\n\n` — the body before the final frame
        // terminator should have zero newlines.
        let body_core = body.strip_suffix("\n\n").unwrap();
        assert!(!body_core.contains('\n'), "body contained newline: {body_core:?}");
    }

    #[test]
    fn done_terminator_matches_openai_literal() {
        // Exact byte match — any drift here silently breaks downstream
        // clients that key off this specific string.
        assert_eq!(done_terminator(), "data: [DONE]\n\n");
    }
}
