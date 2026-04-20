//! Centralized `/v1/messages` body assembler (R-34).
//!
//! Every conditional that shapes the outgoing body lives here as a
//! visible `if` / `match` branch. An auditor reading this file sees
//! every shape the request can take.
//!
//! No prompt logic lives elsewhere — no utility modules mutating the
//! body, no provider-side appliers writing to it. The translator calls
//! [`build_request_body`] once and ships the result.
//!
//! # Current branches (R-57 baseline shape — zero intentional deviation)
//!
//! - `strip_1m_suffix`: `[1m]` alias is stripped here so the model
//!   string matches the wire; callers push the `context-1m-2025-08-07`
//!   beta header on the HTTP side based on the returned flag.
//! - `substitute_environment_in_system`: five per-session literals
//!   (cwd, git flag, platform, shell, os_version) replace the capture
//!   tokens embedded in the main system prompt.
//! - `UserContext.email` / `UserContext.current_date` thread into the
//!   user-context system-reminder via the normalize pipeline.
//! - First user turn receives the three `<system-reminder>` preamble
//!   blocks; subsequent turns do not (see
//!   `translator::anthropic::message_builder`).
//! - Exactly one `cache_control: ephemeral` marker on the last block
//!   of the last message (see `message_builder::add_cache_breakpoints`).
//!
//! # V2+ modifications
//!
//! Future prompt / payload shaping lands as new conditional branches
//! in this file with inline commentary explaining the behavioral
//! target. The single-assembly-file rule (R-34) exists for exactly
//! this — one place to audit every branch.

use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::inference::{OpenAiChatRequest, OpenAiChatRole};
use crate::translator::anthropic::message_builder;

/// Strip the `[1m]` alias suffix off a model string. Returns
/// `(stripped, has_1m)`. Mirrors the reference implementation's
/// `has1mContext` regex `/\[1m\]/i` (case-insensitive). The suffix
/// travels through alias resolution — when present, callers MUST push
/// the `context-1m-2025-08-07` beta header on the outbound request.
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

/// V2 placeholder tokens embedded in harness_corpus/system/03-main-prompt.md.
/// The assembler swaps each for the session's live values before the
/// wire body ships. Placeholders are used instead of capture literals
/// (old "Primary working directory: /workspace" form) so corpus edits
/// don't have to re-anchor against machine-specific capture state.
const PLACEHOLDER_CWD: &str = "_WORKSPACE_DIR_";
const PLACEHOLDER_IS_GIT: &str = "_IS_GIT_REPO_";
const PLACEHOLDER_PLATFORM: &str = "_PLATFORM_";
const PLACEHOLDER_SHELL: &str = "_SHELL_";
const PLACEHOLDER_OS_VERSION: &str = "_OS_VERSION_";

/// Per-session context the assembler injects into the captured body.
/// Email and current_date are always session-live — never hardcoded.
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
    /// Fixture values for byte-match tests only. Reproduces the
    /// `tools-glob-single/turn1` capture environment. Production code
    /// builds its own [`UserContext`] from live environment + OAuth
    /// credentials — never call this outside test paths.
    pub fn capture_defaults() -> UserContext<'static> {
        UserContext {
            email: "test@example.com",
            current_date: "0000-00-00",
            cwd: "/workspace",
            is_git_repo: false,
            platform: "linux",
            shell: "bash",
            os_version: "Linux 6.12.76-linuxkit",
        }
    }
}

/// Post-process `system[]` to substitute per-session environment
/// placeholders in the main agent prompt (`system[3]`). Walks every
/// block and swaps placeholder tokens for session literals — blocks
/// without the `_WORKSPACE_DIR_` anchor are left untouched.
fn substitute_environment_in_system(system: &mut [Value], ctx: &UserContext<'_>) {
    for block in system.iter_mut() {
        let Some(text) = block.get("text").and_then(|v| v.as_str()) else {
            continue;
        };
        if !text.contains(PLACEHOLDER_CWD) {
            continue;
        }
        let replaced = text
            .replace(PLACEHOLDER_CWD, ctx.cwd)
            .replace(PLACEHOLDER_IS_GIT, &ctx.is_git_repo.to_string())
            .replace(PLACEHOLDER_PLATFORM, ctx.platform)
            .replace(PLACEHOLDER_SHELL, ctx.shell)
            .replace(PLACEHOLDER_OS_VERSION, ctx.os_version);
        if replaced != text {
            if let Some(slot) = block.get_mut("text") {
                *slot = Value::String(replaced);
            }
        }
    }
}

/// Build the full outbound `/v1/messages` request body bytes.
///
/// Single entry point per R-34. Every shape-affecting branch lives
/// inline in this function or the helpers above.
///
/// # Errors
/// [`Error::Parse`] when the OpenAI request carries no user message —
/// the target API requires at least one user turn.
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
            "no user message found in request; at least one user turn required".to_string(),
        ));
    }

    // 1. Envelope defaults (metadata, max_tokens, thinking,
    //    context_management, output_config, stream) — byte-verbatim
    //    from the capture, deserialized into JSON.
    let envelope_defaults = super::envelope::build_envelope_defaults();
    let env_obj = envelope_defaults
        .as_object()
        .expect("envelope defaults parse as object");

    // 2. System blocks — 4-entry array (billing header + two
    //    pre-prompt blocks + main agent prompt). Environment tokens
    //    in the main prompt are substituted to the session's actual
    //    values.
    let mut system_blocks = super::system::build_system_blocks();
    substitute_environment_in_system(&mut system_blocks, ctx);

    // 3. Tools array — 9 entries in canonical wire order (Agent,
    //    Bash, Edit, Glob, Grep, Read, Skill, ToolSearch, Write).
    let tools = super::tools::build_tools_array();

    // 4. Messages — two-stage pipeline (normalize → cache-breakpoint).
    //    The first user turn gets the three `<system-reminder>`
    //    preamble blocks; later turns do not.
    let messages = message_builder::build(&req.messages, ctx);

    // 5. Assemble in capture top-level key order:
    //    model < messages < system < tools < metadata < max_tokens
    //    < thinking < context_management < output_config < stream
    let mut body = Map::with_capacity(10);
    body.insert("model".to_string(), Value::String(req.model.clone()));
    body.insert("messages".to_string(), Value::Array(messages));
    body.insert("system".to_string(), Value::Array(system_blocks));
    body.insert("tools".to_string(), Value::Array(tools));
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

    // Rewrite `output_config.effort` from the hardcoded-capture default
    // (`xhigh`) to the per-model default from the catalog — otherwise
    // sonnet / haiku requests 400 because those models do not accept
    // `xhigh`. Uses the stripped model id (without `[1m]`) for lookup.
    let (stripped_for_effort, _) = strip_1m_suffix(&req.model);
    let effort = crate::models::catalog::default_effort_for(&stripped_for_effort);
    if let Some(out_cfg) = body.get_mut("output_config").and_then(|v| v.as_object_mut()) {
        if effort == "auto" {
            // Haiku (and future auto-only tiers) don't accept an explicit
            // effort — drop the key so the server picks.
            out_cfg.remove("effort");
        } else {
            out_cfg.insert("effort".to_string(), Value::String(effort.to_string()));
        }
    }

    // Haiku doesn't support adaptive thinking (server rejects with
    // "adaptive thinking is not supported on this model"). Drop the
    // `thinking` envelope entirely when the model's only supported
    // effort is "auto" — that's the catalog's signal that the model
    // doesn't expose a thinking surface.
    let efforts = crate::models::catalog::by_id(&stripped_for_effort)
        .map(|m| m.supported_efforts)
        .unwrap_or(&[]);
    if efforts == ["auto"] || efforts.is_empty() {
        body.remove("thinking");
        // `clear_thinking_20251015` context_management strategy also
        // requires thinking enabled — server rejects otherwise.
        body.remove("context_management");
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
        assert!(!reminder2.contains("test@example.com"));
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
