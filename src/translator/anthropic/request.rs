

use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::inference::{OpenAiChatRequest, OpenAiChatRole};
use crate::thinking::{ThinkingConfig, ThinkingLevel, ThinkingMode};
use crate::translator::anthropic::message_builder;

/// Map a selected `ThinkingConfig` onto the Anthropic `output_config.effort`
/// string upstream accepts. Kept in one place so codex + anthropic stay in
/// sync: Opus accepts the full ladder (auto/low/medium/high/xhigh/max);
/// Sonnet caps at high; Haiku accepts only auto.
fn thinking_to_effort(cfg: Option<&ThinkingConfig>) -> Option<&'static str> {
    let cfg = cfg?;
    if matches!(cfg.mode, ThinkingMode::None | ThinkingMode::Auto) {
        return None;
    }
    Some(match cfg.level {
        ThinkingLevel::Minimal | ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::XHigh => "xhigh",
        ThinkingLevel::Max => "max",
        ThinkingLevel::None | ThinkingLevel::Auto => return None,
    })
}

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

const PLACEHOLDER_CWD: &str = "_WORKSPACE_DIR_";
const PLACEHOLDER_IS_GIT: &str = "_IS_GIT_REPO_";
const PLACEHOLDER_PLATFORM: &str = "_PLATFORM_";
const PLACEHOLDER_SHELL: &str = "_SHELL_";
const PLACEHOLDER_OS_VERSION: &str = "_OS_VERSION_";
const PLACEHOLDER_MEMORY_DIR: &str = "_MEMORY_DIR_";

#[derive(Debug, Clone)]
pub struct UserContext<'a> {
    pub email: &'a str,
    pub current_date: &'a str,
    pub cwd: &'a str,
    pub is_git_repo: bool,
    pub platform: &'a str,
    pub shell: &'a str,
    pub os_version: &'a str,
    pub memory_dir: &'a str,
    pub git_status: &'a str,
}

impl UserContext<'_> {

    pub fn capture_defaults() -> UserContext<'static> {
        UserContext {
            email: "test@example.com",
            current_date: "0000-00-00",
            cwd: "/workspace",
            is_git_repo: false,
            platform: "linux",
            shell: "bash",
            os_version: "Linux 6.12.76-linuxkit",
            memory_dir: "/root/.otherside/projects/-workspace/memory/",
            git_status: "",
        }
    }
}

fn substitute_environment_in_system(system: &mut [Value], ctx: &UserContext<'_>) {
    for block in system.iter_mut() {
        let Some(text) = block.get("text").and_then(|v| v.as_str()) else {
            continue;
        };
        if !text.contains(PLACEHOLDER_CWD) && !text.contains(PLACEHOLDER_MEMORY_DIR) {
            continue;
        }
        let replaced = text
            .replace(PLACEHOLDER_CWD, ctx.cwd)
            .replace(PLACEHOLDER_IS_GIT, &ctx.is_git_repo.to_string())
            .replace(PLACEHOLDER_PLATFORM, ctx.platform)
            .replace(PLACEHOLDER_SHELL, ctx.shell)
            .replace(PLACEHOLDER_OS_VERSION, ctx.os_version)
            .replace(PLACEHOLDER_MEMORY_DIR, ctx.memory_dir);
        if replaced != text {
            if let Some(slot) = block.get_mut("text") {
                *slot = Value::String(replaced);
            }
        }
    }
}

pub fn build_request_body(
    req: &OpenAiChatRequest,
    ctx: &UserContext<'_>,
) -> Result<Vec<u8>> {
    build_request_body_full(req, ctx, super::system::SystemFlavor::ClaudeCode, None)
}

/// Like `build_request_body` but threads the caller's selected effort via
/// `thinking` into `output_config.effort`. Callers that have no chosen level
/// (e.g. historical tests, fingerprint captures) pass `None` and fall back
/// to `default_effort_for(model)` — the pre-2026-04-22 behavior.
pub fn build_request_body_with_thinking(
    req: &OpenAiChatRequest,
    ctx: &UserContext<'_>,
    thinking: Option<&ThinkingConfig>,
) -> Result<Vec<u8>> {
    build_request_body_full(req, ctx, super::system::SystemFlavor::ClaudeCode, thinking)
}

/// Same as `build_request_body` but lets the provider pick which system
/// flavor to emit. Third-party Anthropic-compat endpoints (Kimi) pass
/// `ThirdParty` to skip the billing header + `You are Claude Code…`
/// opener — both are claude-code-exclusive. The agent preamble + main
/// system prompt still flow so every operational instruction lands.
pub fn build_request_body_with_flavor(
    req: &OpenAiChatRequest,
    ctx: &UserContext<'_>,
    flavor: super::system::SystemFlavor,
) -> Result<Vec<u8>> {
    build_request_body_full(req, ctx, flavor, None)
}

pub fn build_request_body_with_flavor_and_thinking(
    req: &OpenAiChatRequest,
    ctx: &UserContext<'_>,
    flavor: super::system::SystemFlavor,
    thinking: Option<&ThinkingConfig>,
) -> Result<Vec<u8>> {
    build_request_body_full(req, ctx, flavor, thinking)
}

fn build_request_body_full(
    req: &OpenAiChatRequest,
    ctx: &UserContext<'_>,
    flavor: super::system::SystemFlavor,
    thinking: Option<&ThinkingConfig>,
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

    let envelope_defaults = super::envelope::build_envelope_defaults();
    let env_obj = envelope_defaults
        .as_object()
        .expect("envelope defaults parse as object");

    let mut system_blocks = super::system::build_system_blocks_for(flavor);
    substitute_environment_in_system(&mut system_blocks, ctx);

    let tools = super::tools::build_tools_array();

    let messages = message_builder::build(&req.messages, ctx);

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

    let (stripped_for_effort, _) = strip_1m_suffix(&req.model);

    // Effort selection: caller-supplied `thinking` wins when the level maps
    // to a non-auto effort AND the model accepts it; otherwise fall back to
    // the catalog's default effort for this model. Haiku-class models
    // (supported_efforts == ["auto"]) never carry an `effort` field.
    let selected_effort = thinking_to_effort(thinking)
        .filter(|level| crate::models::catalog::supports_effort(&stripped_for_effort, level))
        .unwrap_or_else(|| crate::models::catalog::default_effort_for(&stripped_for_effort));

    if let Some(out_cfg) = body.get_mut("output_config").and_then(|v| v.as_object_mut()) {
        if selected_effort == "auto" {
            out_cfg.remove("effort");
        } else {
            out_cfg.insert(
                "effort".to_string(),
                Value::String(selected_effort.to_string()),
            );
        }
    }

    let efforts = crate::models::catalog::by_id(&stripped_for_effort)
        .map(|m| m.supported_efforts)
        .unwrap_or(&[]);
    if efforts == ["auto"] || efforts.is_empty() {
        body.remove("thinking");

        body.remove("context_management");
    }

    serde_json::to_vec(&Value::Object(body))
        .map_err(|e| Error::Parse(format!("re-serialize failed: {e}")))
}

pub fn build_web_search_body(query: &str, tool_config: Value) -> Vec<u8> {

    let billing_header = crate::fingerprint::anthropic::BILLING_HEADER_TEXT.to_string();

    let user_id = serde_json::json!({
        "device_id": "",
        "account_uuid": "",
        "session_id": "",
    })
    .to_string();

    let body = serde_json::json!({
        "model": "claude-opus-4-7",
        "messages": [{
            "role": "user",
            "content": [{
                "type": "text",
                "text": format!("Perform a web search for the query: {query}"),
                "cache_control": {"type": "ephemeral"},
            }],
        }],
        "system": [
            {"type": "text", "text": billing_header},
            {
                "type": "text",
                "text": crate::harness::SYSTEM_OPENER,
                "cache_control": {"type": "ephemeral"},
            },
            {
                "type": "text",
                "text": "You are an assistant for performing a web search tool use",
                "cache_control": {"type": "ephemeral"},
            },
        ],
        "tools": [tool_config],
        "metadata": {"user_id": user_id},
        "max_tokens": 64000,
        "thinking": {"type": "adaptive"},
        "context_management": {
            "edits": [{"type": "clear_thinking_20251015", "keep": "all"}]
        },
        "output_config": {"effort": "xhigh"},
        "stream": true,
    });
    serde_json::to_vec(&body).expect("web_search request body serializes")
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
    fn build_request_body_no_longer_injects_task_notifications() {

        let req = mvp_request();
        let ctx = UserContext::capture_defaults();
        let bytes = build_request_body(&req, &ctx).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let user_text = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "user")
            .and_then(|m| m["content"].as_array())
            .and_then(|blocks| blocks.last())
            .and_then(|b| b["text"].as_str())
            .expect("user message text present");
        assert!(!user_text.contains("<task-notification>"));
        assert!(user_text.contains("hi"));
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
