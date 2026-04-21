

use crate::config::providers::ProviderId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionTier {

    AntInternal,

    Max,

    TeamPremium,

    NonPremium,
}

impl SubscriptionTier {

    pub fn from_subscription_type(s: Option<&str>) -> Self {
        match s.unwrap_or("").to_ascii_lowercase().as_str() {
            "ant" | "ant_internal" | "internal" => Self::AntInternal,
            "max" => Self::Max,
            "team_premium" | "team-premium" => Self::TeamPremium,
            _ => Self::NonPremium,
        }
    }

    pub fn has_opus_1m(self) -> bool {
        matches!(self, Self::AntInternal | Self::Max | Self::TeamPremium)
    }
}

pub fn default_claude_code_for_tier(tier: SubscriptionTier) -> &'static str {
    if tier.has_opus_1m() {
        "claude-opus-4-7[1m]"
    } else {
        "claude-opus-4-7"
    }
}

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
