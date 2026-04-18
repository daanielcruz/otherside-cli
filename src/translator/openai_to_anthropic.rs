//! `openai → anthropic` request body translation.
//!
//! # Pipeline (change 009)
//!
//! 1. Envelope defaults come from `harness::envelope::build_envelope_defaults`
//!    (`fingerprint_corpus/harness/envelope.json`, byte-verbatim from
//!    capture).
//! 2. `system[]` comes from `harness::system::build_system_blocks` and is
//!    post-processed to substitute session environment values (cwd / git
//!    flag / platform / shell / os version) in the main system prompt.
//! 3. `tools[]` comes from `harness::tools::build_tools_array` in the
//!    canonical upstream order (Agent, Bash, Edit, Glob, Grep, Read,
//!    Skill, ToolSearch, Write).
//! 4. `messages[]` comes from `message_builder::build` — two-stage
//!    normalize + add_cache_breakpoints pipeline mirroring upstream
//!    `utils/messages.ts` + `services/api/claude.ts`.
//! 5. Top-level keys are inserted in capture key order:
//!    `model, messages, system, tools, metadata, max_tokens, thinking,
//!    context_management, output_config, stream`.
//!
//! # Conformance
//!
//! Under capture-identical inputs the emitted body byte-matches
//! `fingerprint_corpus/tools-glob-single/turn1/request.body.json`
//! (parsed equality — see `tests/translator_multi_turn.rs`). Turn 2
//! and turn 3 byte-match under the scrubbed-placeholder whitelist for
//! `tool_use.id` / `tool_result.tool_use_id` / `metadata.user_id.*`.
//!
//! # Previous (hello-template) approach — RETIRED
//!
//! 001's `hello/request.body.json` was the single-turn regression
//! anchor; 009 supersedes it with the multi-turn harness. The hello
//! capture is frozen on disk but no longer drives byte-match tests
//! because the upstream version producing it predates the current
//! harness artifacts. tools-glob-single/turn1 is the new single-turn
//! anchor.

use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::harness;
use crate::inference::{OpenAiChatRequest, OpenAiChatRole};

pub mod blocks;
pub mod message_builder;

/// Strip the `[1m]` alias suffix off a model string. Returns
/// `(stripped, has_1m)`. Mirrors upstream `has1mContext`'s regex
/// `/\[1m\]/i` (case-insensitive). The suffix travels through alias
/// resolution — when present, callers MUST push the
/// `context-1m-2025-08-07` beta header on the outbound request.
pub fn strip_1m_suffix(raw: &str) -> (String, bool) {
    let lower = raw.to_ascii_lowercase();
    if let Some(idx) = lower.find("[1m]") {
        let mut stripped = String::with_capacity(raw.len() - 4);
        stripped.push_str(&raw[..idx]);
        stripped.push_str(&raw[idx + 4..]);
        return (stripped, true);
    }
    (raw.to_string(), false)
}

/// Captured environment literals (from tools-glob-single/turn1 system[3]).
/// These are the tokens the translator substitutes to per-session values.
const CAPTURE_CWD: &str = "Primary working directory: /workspace";
const CAPTURE_IS_GIT: &str = "Is a git repository: false";
const CAPTURE_PLATFORM: &str = "- Platform: linux";
const CAPTURE_SHELL: &str = "- Shell: bash";
const CAPTURE_OS_VERSION: &str = "- OS Version: Linux 6.12.76-linuxkit";
const CAPTURE_EMAIL: &str = "edaanxx@gmail.com";
const CAPTURE_DATE: &str = "2026-04-18";

/// Per-session context the translator injects into the captured body.
#[derive(Debug, Clone)]
pub struct UserContext<'a> {
    pub email: &'a str,
    pub current_date: &'a str,
    pub cwd: &'a str,
    pub is_git_repo: bool,
    pub platform: &'a str,
    pub shell: &'a str,
    pub os_version: &'a str,
}

impl UserContext<'_> {
    /// Values matching the `tools-glob-single/turn1` capture — supply
    /// these to reproduce capture bytes for byte-match tests. Production
    /// callers build their own `UserContext` from live environment.
    pub fn capture_defaults() -> UserContext<'static> {
        UserContext {
            email: CAPTURE_EMAIL,
            current_date: CAPTURE_DATE,
            cwd: "/workspace",
            is_git_repo: false,
            platform: "linux",
            shell: "bash",
            os_version: "Linux 6.12.76-linuxkit",
        }
    }
}

/// Post-process `system[]` to substitute per-session environment literals
/// in the main agent prompt (`system[3]`).
fn substitute_environment_in_system(system: &mut [Value], ctx: &UserContext<'_>) {
    for block in system.iter_mut() {
        let Some(text) = block.get("text").and_then(|v| v.as_str()) else {
            continue;
        };
        if !text.contains("Primary working directory:") {
            continue;
        }
        let replaced = text
            .replace(CAPTURE_CWD, &format!("Primary working directory: {}", ctx.cwd))
            .replace(
                CAPTURE_IS_GIT,
                &format!("Is a git repository: {}", ctx.is_git_repo),
            )
            .replace(CAPTURE_PLATFORM, &format!("- Platform: {}", ctx.platform))
            .replace(CAPTURE_SHELL, &format!("- Shell: {}", ctx.shell))
            .replace(
                CAPTURE_OS_VERSION,
                &format!("- OS Version: {}", ctx.os_version),
            );
        if replaced != text {
            if let Some(slot) = block.get_mut("text") {
                *slot = Value::String(replaced);
            }
        }
    }
}

/// Build the full outbound `/v1/messages` request body bytes.
///
/// # Errors
/// [`Error::Parse`] when the OpenAI request carries no user message —
/// Anthropic requires at least one user turn.
pub fn build_request_body(
    req: &OpenAiChatRequest,
    ctx: &UserContext<'_>,
) -> Result<Vec<u8>> {
    if !req
        .messages
        .iter()
        .any(|m| matches!(m.role, OpenAiChatRole::User))
    {
        return Err(Error::Parse(
            "no user message found in request; Anthropic requires at least one user turn"
                .to_string(),
        ));
    }

    let envelope_defaults = harness::envelope::build_envelope_defaults();
    let env_obj = envelope_defaults
        .as_object()
        .expect("envelope defaults parse as object");

    // Build system[] then post-process environment substitutions.
    let mut system_blocks = harness::system::build_system_blocks();
    substitute_environment_in_system(&mut system_blocks, ctx);

    let tools = harness::tools::build_tools_array();
    let messages = message_builder::build(&req.messages, ctx);

    // Insert keys in capture top-level order.
    let mut body = Map::with_capacity(10);
    body.insert("model".to_string(), Value::String(req.model.clone()));
    body.insert("messages".to_string(), Value::Array(messages));
    body.insert("system".to_string(), Value::Array(system_blocks));
    body.insert("tools".to_string(), Value::Array(tools));
    // Then envelope defaults in their own capture key order.
    for key in [
        "metadata",
        "max_tokens",
        "thinking",
        "context_management",
        "output_config",
        "stream",
    ] {
        if let Some(v) = env_obj.get(key) {
            body.insert(key.to_string(), v.clone());
        }
    }

    serde_json::to_vec(&Value::Object(body))
        .map_err(|e| Error::Parse(format!("re-serialize failed: {e}")))
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
    fn build_returns_valid_json_for_single_user_turn() {
        let req = mvp_request();
        let ctx = UserContext::capture_defaults();
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["model"], "claude-opus-4-7");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["system"].as_array().unwrap().len(), 4);
        assert_eq!(body["tools"].as_array().unwrap().len(), 9);
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn preserves_top_level_key_order() {
        let req = mvp_request();
        let ctx = UserContext::capture_defaults();
        let bytes = build_request_body(&req, &ctx).unwrap();
        let s = std::str::from_utf8(&bytes).unwrap();
        // Order: model < messages < system < tools < metadata < max_tokens
        //        < thinking < context_management < output_config < stream.
        let idx = |k: &str| s.find(&format!("\"{k}\"")).expect("key present");
        assert!(idx("model") < idx("messages"));
        assert!(idx("messages") < idx("system"));
        assert!(idx("system") < idx("tools"));
        assert!(idx("tools") < idx("metadata"));
        assert!(idx("metadata") < idx("max_tokens"));
        assert!(idx("max_tokens") < idx("thinking"));
        assert!(idx("thinking") < idx("context_management"));
        assert!(idx("context_management") < idx("output_config"));
        assert!(idx("output_config") < idx("stream"));
    }

    #[test]
    fn substitutes_user_prompt_into_messages() {
        let mut req = mvp_request();
        req.messages[0].content = "different prompt text".to_string();
        let ctx = UserContext::capture_defaults();
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        // First user turn has 4 content blocks: 3 preamble + 1 prompt.
        let prompt = &body["messages"][0]["content"][3]["text"];
        assert_eq!(prompt.as_str(), Some("different prompt text"));
    }

    #[test]
    fn substitutes_email_and_date_in_user_context_reminder() {
        let req = mvp_request();
        let ctx = UserContext {
            email: "someone.else@example.com",
            current_date: "2027-01-01",
            ..UserContext::capture_defaults()
        };
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let reminder2 = body["messages"][0]["content"][2]["text"]
            .as_str()
            .unwrap();
        assert!(reminder2.contains("someone.else@example.com"));
        assert!(reminder2.contains("2027-01-01"));
        assert!(!reminder2.contains(CAPTURE_EMAIL));
    }

    #[test]
    fn substitutes_environment_block_in_system_prompt() {
        let req = mvp_request();
        let ctx = UserContext {
            cwd: "/Users/alice/proj",
            is_git_repo: true,
            platform: "darwin",
            shell: "zsh",
            os_version: "Darwin 25.3.0",
            ..UserContext::capture_defaults()
        };
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let env_block = body["system"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|b| {
                b["text"]
                    .as_str()
                    .filter(|t| t.contains("# Environment"))
            })
            .expect("environment section present in system[]");
        assert!(env_block.contains("Primary working directory: /Users/alice/proj"));
        assert!(env_block.contains("Is a git repository: true"));
        assert!(env_block.contains("- Platform: darwin"));
        assert!(env_block.contains("- Shell: zsh"));
        assert!(env_block.contains("- OS Version: Darwin 25.3.0"));
        assert!(!env_block.contains("/workspace"));
        assert!(!env_block.contains("Linux 6.12.76-linuxkit"));
    }

    #[test]
    fn requires_at_least_one_user_message() {
        let mut req = mvp_request();
        req.messages.clear();
        let err = build_request_body(&req, &UserContext::capture_defaults()).unwrap_err();
        assert!(matches!(err, Error::Parse(_)));
    }

    #[test]
    fn strip_1m_suffix_handles_bracket_variants() {
        assert_eq!(
            strip_1m_suffix("claude-opus-4-7[1m]"),
            ("claude-opus-4-7".to_string(), true)
        );
        assert_eq!(strip_1m_suffix("opus[1m]"), ("opus".to_string(), true));
        assert_eq!(
            strip_1m_suffix("opus[1M]"),
            ("opus".to_string(), true),
            "[1M] must be recognized case-insensitively"
        );
        assert_eq!(
            strip_1m_suffix("claude-opus-4-7[1m](xhigh)"),
            ("claude-opus-4-7(xhigh)".to_string(), true)
        );
        assert_eq!(
            strip_1m_suffix("claude-opus-4-7"),
            ("claude-opus-4-7".to_string(), false)
        );
    }

    #[test]
    fn advertises_nine_tools_in_canonical_order() {
        let req = mvp_request();
        let ctx = UserContext::capture_defaults();
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let names: Vec<&str> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec!["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"]
        );
    }
}
