//! Per-provider default model + subscription-tier aware resolution.
//!
//! Mirrors upstream `utils/model/model.ts::getDefaultMainLoopModelSetting`:
//!
//! - Ant internal → `opus[1m]`.
//! - Max subscriber → `opus` + `[1m]` if `isOpus1mMergeEnabled`.
//! - Team Premium → same as Max.
//! - PAYG / Enterprise / Team Standard / Pro → `sonnet` (no 1M).
//!
//! For providers other than `ClaudeCode` the tier is irrelevant —
//! their dispatch is frozen and the table carries the static
//! per-provider default alias used by the Config tab's Provider
//! switcher.

use crate::config::providers::ProviderId;

/// Subscription tier inferred from the OAuth token's
/// `subscription_type` field (Anthropic). String values follow
/// upstream `utils/auth.ts` conventions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionTier {
    /// Ant internal user. Always gets opus[1m].
    AntInternal,
    /// Max plan subscriber.
    Max,
    /// Team Premium plan — same defaults as Max.
    TeamPremium,
    /// Pro / Team Standard / Enterprise / PAYG — falls back to sonnet
    /// without 1M.
    NonPremium,
}

impl SubscriptionTier {
    /// Parse from the string upstream writes into the token cache.
    /// Unknown values collapse to `NonPremium` so a new tier does not
    /// silently unlock 1M context — upstream behavior is
    /// allowlist-shaped, not denylist-shaped.
    pub fn from_subscription_type(s: Option<&str>) -> Self {
        match s.unwrap_or("").to_ascii_lowercase().as_str() {
            "ant" | "ant_internal" | "internal" => Self::AntInternal,
            "max" => Self::Max,
            "team_premium" | "team-premium" => Self::TeamPremium,
            _ => Self::NonPremium,
        }
    }

    /// True if this tier is entitled to the opus 1M-context variant.
    /// Upstream gates the actual render on a feature flag
    /// (`isOpus1mMergeEnabled`) even for entitled tiers — when that
    /// flag lands in otherside it should short-circuit this to false.
    pub fn has_opus_1m(self) -> bool {
        matches!(self, Self::AntInternal | Self::Max | Self::TeamPremium)
    }
}

/// Default model id for the `ClaudeCode` provider given a
/// subscription tier.
///
/// Opus is ALWAYS the anthropic default — only the `[1m]` 1M-context
/// variant is tier-gated. Accounts without 1M entitlement land on
/// plain opus (not sonnet — sonnet is a user-chosen alternative, not
/// a tier-mandated default).
pub fn default_claude_code_for_tier(tier: SubscriptionTier) -> &'static str {
    if tier.has_opus_1m() {
        "claude-opus-4-7[1m]"
    } else {
        "claude-opus-4-7"
    }
}

/// Static per-provider fallback. Returned when the caller has no tier
/// context (e.g. Provider switcher row picking the default for a
/// provider whose OAuth flow hasn't run yet). For `ClaudeCode` this
/// optimistically assumes Max entitlement; `subscription_tier_default`
/// overrides once credentials are loaded.
pub fn default_model_for(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::ClaudeCode => "claude-opus-4-7[1m]",
        ProviderId::Codex => "gpt-5.4",
        ProviderId::GeminiCli => "gemini-3.1-pro-preview",
        ProviderId::OpenAiCustom => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_defaults_to_opus_1m() {
        assert_eq!(default_model_for(ProviderId::ClaudeCode), "claude-opus-4-7[1m]");
    }

    #[test]
    fn codex_defaults_to_gpt54() {
        assert_eq!(default_model_for(ProviderId::Codex), "gpt-5.4");
    }

    #[test]
    fn gemini_defaults_to_3_1_pro_preview() {
        assert_eq!(default_model_for(ProviderId::GeminiCli), "gemini-3.1-pro-preview");
    }

    #[test]
    fn openai_custom_is_empty() {
        assert_eq!(default_model_for(ProviderId::OpenAiCustom), "");
    }

    #[test]
    fn ant_internal_gets_opus_1m() {
        assert_eq!(
            default_claude_code_for_tier(SubscriptionTier::AntInternal),
            "claude-opus-4-7[1m]"
        );
    }

    #[test]
    fn max_gets_opus_1m() {
        assert_eq!(
            default_claude_code_for_tier(SubscriptionTier::Max),
            "claude-opus-4-7[1m]"
        );
    }

    #[test]
    fn team_premium_gets_opus_1m() {
        assert_eq!(
            default_claude_code_for_tier(SubscriptionTier::TeamPremium),
            "claude-opus-4-7[1m]"
        );
    }

    #[test]
    fn non_premium_gets_non_1m_opus() {
        // Opus is anthropic's universal default; non-premium accounts
        // just lose the 1M-context variant.
        assert_eq!(
            default_claude_code_for_tier(SubscriptionTier::NonPremium),
            "claude-opus-4-7"
        );
    }

    #[test]
    fn subscription_type_parsing_handles_known_values() {
        assert_eq!(
            SubscriptionTier::from_subscription_type(Some("max")),
            SubscriptionTier::Max
        );
        assert_eq!(
            SubscriptionTier::from_subscription_type(Some("MAX")),
            SubscriptionTier::Max
        );
        assert_eq!(
            SubscriptionTier::from_subscription_type(Some("team_premium")),
            SubscriptionTier::TeamPremium
        );
        assert_eq!(
            SubscriptionTier::from_subscription_type(Some("ant")),
            SubscriptionTier::AntInternal
        );
        assert_eq!(
            SubscriptionTier::from_subscription_type(Some("pro")),
            SubscriptionTier::NonPremium
        );
        assert_eq!(
            SubscriptionTier::from_subscription_type(None),
            SubscriptionTier::NonPremium
        );
    }

    #[test]
    fn unknown_tier_stays_non_premium() {
        assert_eq!(
            SubscriptionTier::from_subscription_type(Some("future-plan-xyz")),
            SubscriptionTier::NonPremium
        );
    }
}
