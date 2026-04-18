//! `openai → anthropic` request body + SSE event translation.
//!
//! # Responsibilities (MVP)
//!
//! Given a canonical OpenAI chat completion request, produce an Anthropic
//! `/v1/messages` request body that matches captured Claude Code 2.1.113
//! traffic at the byte level — per C36 (maximum fingerprint
//! indistinguishability). The only allowed variances are:
//!
//! - The user's literal prompt text
//! - Session-level `userEmail` and `currentDate` fields (embedded inside
//!   one of the `system-reminder` content blocks)
//! - Session ID UUID (header, not body)
//! - Request ID UUID (header, not body)
//!
//! Everything else — billing header, agent-prompt blocks, tool
//! definitions, `max_tokens`, `thinking`, `context_management`,
//! `output_config`, `cache_control` on the user block — is copied
//! verbatim from the captured corpus template.
//!
//! # Template approach
//!
//! Rather than reconstructing the ~63KB body field-by-field in Rust
//! source (brittle, enormous, easy to drift from captured wire format),
//! we `include_str!` the scrubbed golden corpus and use it as the
//! template. At runtime we clone it, substitute the user-specific text
//! fields, and serialize with `preserve_order`.
//!
//! The template was captured from
//! `fingerprint_corpus/hello/request.body.json` — scrubbed of session
//! IDs, request IDs, and tokens (none are in the body anyway — those
//! live in headers).
//!
//! # Not yet implemented
//!
//! - SSE event translation (anthropic → openai) — MVP task §10.
//! - Thinking-config-driven field mutation (currently uses template's
//!   thinking field verbatim).

use serde_json::Value;

use crate::error::{Error, Result};
use crate::inference::OpenAiChatRequest;

/// Scrubbed template body: captured real Claude Code 2.1.113 hello
/// request body. Embedded at compile time. Cloned and mutated per
/// request.
const BODY_TEMPLATE_JSON: &str = include_str!(
    "../../fingerprint_corpus/hello/request.body.json"
);

/// Captured placeholder values that the template has for session-specific
/// fields. At build time we replace these with the current session's
/// values.
const PLACEHOLDER_EMAIL: &str = "edaanxx@gmail.com";
const PLACEHOLDER_DATE: &str = "2026-04-17";

/// User-session context that parameterizes the template.
#[derive(Debug, Clone)]
pub struct UserContext<'a> {
    /// User's email — interpolated into the "user context"
    /// system-reminder block.
    pub email: &'a str,
    /// Today's date in `YYYY-MM-DD` format — interpolated into the same
    /// system-reminder block.
    pub current_date: &'a str,
}

/// Build the full `/v1/messages` request body for the Anthropic provider.
///
/// Returns the exact UTF-8 bytes that go on the wire (axios-style
/// compact JSON, key order per corpus).
///
/// # Errors
///
/// Returns [`Error::Parse`] if the OpenAI request doesn't have at least
/// one user message, or if the template fails to load (should never
/// happen in practice — the template is compile-time embedded and
/// validated by tests).
pub fn build_request_body(
    req: &OpenAiChatRequest,
    ctx: &UserContext<'_>,
) -> Result<Vec<u8>> {
    // Parse the template each call. This is wasteful (reparse ~63KB
    // per request) but safe — no mutable shared state. We can optimize
    // later with OnceLock<Value> + deep clone if profiling flags it.
    let mut body: Value = serde_json::from_str(BODY_TEMPLATE_JSON)
        .map_err(|e| Error::Parse(format!("body template is malformed: {e}")))?;

    // Extract the user prompt from the last user message in the OpenAI
    // request. For MVP we only support a single user message — the
    // template's messages[0] is hardcoded as role=user with 4 content
    // blocks.
    let user_prompt = req
        .messages
        .iter()
        .rev()
        .find(|m| matches!(m.role, crate::inference::OpenAiChatRole::User))
        .map(|m| m.content.as_str())
        .ok_or_else(|| {
            Error::Parse(
                "no user message found in request; MVP requires at least one user message"
                    .to_string(),
            )
        })?;

    // Substitute into the user-context system-reminder block
    // (messages[0].content[2].text contains 'edaanxx@gmail.com' and
    // '2026-04-17' in the captured template).
    if let Some(content) = body
        .get_mut("messages")
        .and_then(|m| m.as_array_mut())
        .and_then(|a| a.get_mut(0))
        .and_then(|m| m.get_mut("content"))
        .and_then(|c| c.as_array_mut())
    {
        // Block [2]: substitute email + date.
        if let Some(block2) = content.get_mut(2).and_then(|b| b.get_mut("text")) {
            if let Some(text) = block2.as_str() {
                let new_text = text
                    .replace(PLACEHOLDER_EMAIL, ctx.email)
                    .replace(PLACEHOLDER_DATE, ctx.current_date);
                *block2 = Value::String(new_text);
            }
        }
        // Block [3]: substitute the user's literal prompt text.
        if let Some(block3) = content.get_mut(3).and_then(|b| b.get_mut("text")) {
            *block3 = Value::String(user_prompt.to_string());
        }
    }

    // Serialize to bytes. preserve_order keeps the original key order.
    serde_json::to_vec(&body).map_err(|e| Error::Parse(format!("re-serialize failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::{OpenAiChatMessage, OpenAiChatRole};

    fn mvp_request() -> OpenAiChatRequest {
        OpenAiChatRequest {
            model: "claude-opus-4-7".to_string(),
            messages: vec![OpenAiChatMessage {
                role: OpenAiChatRole::User,
                content: "hi".to_string(),
                ..Default::default()
            }],
            stream: Some(true),
            ..Default::default()
        }
    }

    #[test]
    fn build_matches_captured_corpus_byte_for_byte() {
        // When called with the same inputs that produced the captured
        // corpus (prompt="hi", email=edaanxx@gmail.com, date=2026-04-17),
        // the output MUST byte-match the corpus body exactly. This is
        // the C36 conformance gate.
        let req = mvp_request();
        let ctx = UserContext {
            email: PLACEHOLDER_EMAIL,
            current_date: PLACEHOLDER_DATE,
        };
        let actual = build_request_body(&req, &ctx).unwrap();

        // Expected = corpus JSON re-serialized compact (serde_json::to_vec
        // emits compact by default).
        let expected_value: Value = serde_json::from_str(BODY_TEMPLATE_JSON).unwrap();
        let expected = serde_json::to_vec(&expected_value).unwrap();

        assert_eq!(
            actual.len(),
            expected.len(),
            "body length diverges: actual={} expected={}",
            actual.len(),
            expected.len()
        );
        assert_eq!(actual, expected, "body bytes diverge from captured corpus");
    }

    #[test]
    fn substitutes_user_prompt() {
        let mut req = mvp_request();
        req.messages[0].content = "different prompt text".to_string();
        let ctx = UserContext {
            email: PLACEHOLDER_EMAIL,
            current_date: PLACEHOLDER_DATE,
        };
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let content3 = &body["messages"][0]["content"][3]["text"];
        assert_eq!(content3.as_str(), Some("different prompt text"));
    }

    #[test]
    fn substitutes_user_context_email_and_date() {
        let req = mvp_request();
        let ctx = UserContext {
            email: "someone.else@example.com",
            current_date: "2027-01-01",
        };
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let content2_text = body["messages"][0]["content"][2]["text"]
            .as_str()
            .unwrap();
        assert!(
            content2_text.contains("someone.else@example.com"),
            "user context block should contain new email"
        );
        assert!(
            content2_text.contains("2027-01-01"),
            "user context block should contain new date"
        );
        assert!(
            !content2_text.contains(PLACEHOLDER_EMAIL),
            "original captured email should be replaced"
        );
    }

    #[test]
    fn preserves_top_level_key_order() {
        let req = mvp_request();
        let ctx = UserContext {
            email: PLACEHOLDER_EMAIL,
            current_date: PLACEHOLDER_DATE,
        };
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body_str = std::str::from_utf8(&bytes).unwrap();
        let model_idx = body_str.find("\"model\"").unwrap();
        let messages_idx = body_str.find("\"messages\"").unwrap();
        let system_idx = body_str.find("\"system\"").unwrap();
        let tools_idx = body_str.find("\"tools\"").unwrap();
        assert!(
            model_idx < messages_idx
                && messages_idx < system_idx
                && system_idx < tools_idx,
            "top-level keys must appear in order model < messages < system < tools"
        );
    }

    #[test]
    fn requires_user_message() {
        let mut req = mvp_request();
        req.messages.clear();
        let ctx = UserContext {
            email: "e",
            current_date: "d",
        };
        let err = build_request_body(&req, &ctx).unwrap_err();
        assert!(matches!(err, Error::Parse(_)));
    }
}
