//! Build the three `<system-reminder>`-wrapped text blocks prepended to
//! the first user turn.
//!
//! Each reminder is stored byte-verbatim (including wrapper + any trailing
//! whitespace) in `fingerprint_corpus/harness/system-reminders/`. Only
//! `user-context.tmpl` has placeholders — `{{email}}` and
//! `{{current_date}}` — substituted per-session.
//!
//! Order on the wire (verified against capture):
//! 0. deferred-tools notice
//! 1. skills catalog
//! 2. user-context (email + date)

use serde_json::{json, Value};

use super::{REMINDER_DEFERRED_TOOLS, REMINDER_SKILLS, REMINDER_USER_CONTEXT_TMPL};

/// Substitute `{{email}}` and `{{current_date}}` in the user-context
/// template. Template placeholders are literal strings — no regex, no
/// escaping required.
pub fn render_user_context(email: &str, current_date: &str) -> String {
    REMINDER_USER_CONTEXT_TMPL
        .replace("{{email}}", email)
        .replace("{{current_date}}", current_date)
}

/// Produce the three preamble content blocks (text type) for
/// `messages[0].content[0..3]`. The 4th content block — the user's
/// literal prompt — is appended by the translator at a higher layer.
pub fn build_preamble_blocks(email: &str, current_date: &str) -> [Value; 3] {
    [
        json!({ "type": "text", "text": REMINDER_DEFERRED_TOOLS }),
        json!({ "type": "text", "text": REMINDER_SKILLS }),
        json!({ "type": "text", "text": render_user_context(email, current_date) }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_three_blocks() {
        let blocks = build_preamble_blocks("a@b.com", "2026-04-18");
        assert_eq!(blocks.len(), 3);
        for b in blocks.iter() {
            assert_eq!(b["type"], "text");
            assert!(b["text"].is_string());
        }
    }

    #[test]
    fn user_context_substitutes_placeholders() {
        let rendered = render_user_context("user@example.com", "2099-12-31");
        assert!(rendered.contains("user@example.com"));
        assert!(rendered.contains("2099-12-31"));
        assert!(!rendered.contains("{{email}}"));
        assert!(!rendered.contains("{{current_date}}"));
    }

    #[test]
    fn deferred_tools_keeps_wrapper() {
        let blocks = build_preamble_blocks("e", "d");
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.starts_with("<system-reminder>"));
        assert!(text.contains("</system-reminder>"));
    }

    #[test]
    fn skills_trailing_newline_preserved() {
        // Skills reminder in capture ends with "</system-reminder>\n".
        let blocks = build_preamble_blocks("e", "d");
        let text = blocks[1]["text"].as_str().unwrap();
        assert!(text.ends_with("</system-reminder>\n"));
    }

    #[test]
    fn user_context_double_trailing_newline_preserved() {
        // User-context reminder in capture ends with "</system-reminder>\n\n".
        let blocks = build_preamble_blocks("e", "d");
        let text = blocks[2]["text"].as_str().unwrap();
        assert!(text.ends_with("</system-reminder>\n\n"));
    }
}
