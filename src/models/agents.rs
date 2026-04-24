

use super::aliases;
use crate::config::providers::ProviderId;
use crate::thinking::ThinkingLevel;

pub const INHERIT_SENTINEL: &str = "inherit";

pub struct AgentOverride {
    pub model: &'static str,
    pub effort: Option<ThinkingLevel>,
}

pub fn resolve_agent_override(
    agent_name: &str,
    provider_id: ProviderId,
) -> Option<AgentOverride> {
    let name_lower = agent_name.to_ascii_lowercase();
    // Per-(agent, provider) matrix — user directive 2026-04-24.
    //
    // Kimi is always None so every kimi subagent inherits the main turn's
    // model; the kimi catalog isn't locally pinned and Moonshot's flagship
    // label shifts across releases, so inheriting is the only safe default.
    match (name_lower.as_str(), provider_id) {
        ("plan", ProviderId::ClaudeCode)
        | ("verification", ProviderId::ClaudeCode) => Some(AgentOverride {
            model: "claude-opus-4-7",
            effort: None,
        }),
        ("plan", ProviderId::Codex)
        | ("verification", ProviderId::Codex) => Some(AgentOverride {
            model: "gpt-5.5",
            effort: None,
        }),
        ("explore", ProviderId::ClaudeCode)
        | ("general-purpose", ProviderId::ClaudeCode) => Some(AgentOverride {
            model: "claude-sonnet-4-6",
            effort: None,
        }),
        ("explore", ProviderId::Codex)
        | ("general-purpose", ProviderId::Codex) => Some(AgentOverride {
            model: "gpt-5.5",
            effort: Some(ThinkingLevel::Medium),
        }),
        _ => None,
    }
}

pub fn resolve_agent_model(
    invocation_model: Option<&str>,
    frontmatter_model: Option<&str>,
    parent_model: &str,
) -> String {
    resolve_agent_model_for_provider(
        invocation_model,
        frontmatter_model,
        parent_model,
        ProviderId::ClaudeCode,
    )
}

pub fn resolve_agent_model_for_provider(
    invocation_model: Option<&str>,
    frontmatter_model: Option<&str>,
    parent_model: &str,
    provider_id: ProviderId,
) -> String {
    resolve_agent_dispatch(
        None,
        invocation_model,
        frontmatter_model,
        parent_model,
        provider_id,
    )
    .0
}

pub fn resolve_agent_dispatch(
    agent_name: Option<&str>,
    invocation_model: Option<&str>,
    frontmatter_model: Option<&str>,
    parent_model: &str,
    provider_id: ProviderId,
) -> (String, Option<ThinkingLevel>) {
    if invocation_model.is_none() && frontmatter_model.is_none() {
        if let Some(name) = agent_name {
            if let Some(ov) = resolve_agent_override(name, provider_id) {
                return (ov.model.to_string(), ov.effort);
            }
        }
    }
    if let Some(m) = invocation_model {
        return (
            coerce_compatible(&aliases::resolve(m), parent_model, provider_id),
            None,
        );
    }
    let candidate = match frontmatter_model {
        Some(m) if m == INHERIT_SENTINEL || m.is_empty() => aliases::resolve(parent_model),
        Some(m) => aliases::resolve(m),
        None => aliases::resolve(parent_model),
    };
    (
        coerce_compatible(&candidate, parent_model, provider_id),
        None,
    )
}

fn coerce_compatible(
    candidate: &str,
    parent_model: &str,
    provider_id: ProviderId,
) -> String {
    if provider_compatible(candidate, provider_id) {
        return candidate.to_string();
    }
    let parent_resolved = aliases::resolve(parent_model);
    if provider_compatible(&parent_resolved, provider_id) {
        return parent_resolved;
    }
    candidate.to_string()
}

fn provider_compatible(model_id: &str, provider_id: ProviderId) -> bool {
    let lower = model_id.to_ascii_lowercase();
    match provider_id {
        ProviderId::ClaudeCode => lower.starts_with("claude-"),
        ProviderId::Codex => lower.starts_with("gpt-") || lower.starts_with("o1") || lower.starts_with("o3") || lower.starts_with("o4"),
        ProviderId::Kimi => lower.starts_with("kimi-") || lower.starts_with("moonshot"),
        ProviderId::GeminiCli => lower.starts_with("gemini-"),
        ProviderId::OpenAiCustom => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invocation_wins_over_frontmatter() {
        assert_eq!(
            resolve_agent_model(Some("haiku"), Some("opus"), "claude-sonnet-4-6"),
            "claude-haiku-4-5"
        );
    }

    #[test]
    fn frontmatter_used_when_no_invocation() {
        assert_eq!(
            resolve_agent_model(None, Some("sonnet"), "claude-opus-4-7[1m]"),
            "claude-sonnet-4-6"
        );
    }

    #[test]
    fn inherit_sentinel_falls_back_to_parent() {
        assert_eq!(
            resolve_agent_model(None, Some("inherit"), "claude-opus-4-7[1m]"),
            "claude-opus-4-7[1m]"
        );
    }

    #[test]
    fn no_frontmatter_falls_back_to_parent() {
        assert_eq!(
            resolve_agent_model(None, None, "claude-opus-4-7[1m]"),
            "claude-opus-4-7[1m]"
        );
    }

    #[test]
    fn parent_alias_gets_resolved() {

        assert_eq!(
            resolve_agent_model(None, Some("inherit"), "opus"),
            "claude-opus-4-7"
        );
    }

    #[test]
    fn codex_parent_with_sonnet_frontmatter_falls_back_to_parent() {
        assert_eq!(
            resolve_agent_model_for_provider(
                None,
                Some("sonnet"),
                "gpt-5.5",
                ProviderId::Codex,
            ),
            "gpt-5.5",
            "frontmatter sonnet alias must not fire under codex provider — incompatible family would trip server 400"
        );
    }

    #[test]
    fn kimi_parent_with_opus_frontmatter_falls_back_to_parent() {
        assert_eq!(
            resolve_agent_model_for_provider(
                None,
                Some("opus"),
                "kimi-k2-thinking",
                ProviderId::Kimi,
            ),
            "kimi-k2-thinking"
        );
    }

    #[test]
    fn kimi_verification_inherits_parent_model() {
        let (model, effort) = resolve_agent_dispatch(
            Some("verification"),
            None,
            None,
            "kimi-k2-thinking",
            ProviderId::Kimi,
        );
        assert_eq!(model, "kimi-k2-thinking", "kimi subagents MUST ride the parent model, never a hardcoded override");
        assert!(effort.is_none());
    }

    #[test]
    fn codex_parent_no_frontmatter_inherits_parent() {
        assert_eq!(
            resolve_agent_model_for_provider(
                None,
                None,
                "gpt-5.5",
                ProviderId::Codex,
            ),
            "gpt-5.5"
        );
    }

    #[test]
    fn anthropic_parent_with_sonnet_frontmatter_keeps_claude_id() {
        assert_eq!(
            resolve_agent_model_for_provider(
                None,
                Some("sonnet"),
                "claude-opus-4-7",
                ProviderId::ClaudeCode,
            ),
            "claude-sonnet-4-6"
        );
    }

    #[test]
    fn codex_invocation_with_incompatible_model_falls_back() {
        assert_eq!(
            resolve_agent_model_for_provider(
                Some("haiku"),
                None,
                "gpt-5.5",
                ProviderId::Codex,
            ),
            "gpt-5.5",
            "an explicit invocation.model of `haiku` under a codex parent must NOT leak claude-haiku-4-5 — server would 400"
        );
    }
}
