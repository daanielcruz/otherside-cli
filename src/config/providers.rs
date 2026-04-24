
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderId {
    ClaudeCode,
    Codex,
    GeminiCli,
    Kimi,
    OpenAiCustom,
}

impl Default for ProviderId {
    fn default() -> Self {
        ProviderId::ClaudeCode
    }
}

impl ProviderId {

    pub fn slug(self) -> &'static str {
        match self {
            ProviderId::ClaudeCode => "anthropic-oauth",
            ProviderId::Codex => "codex-oauth",
            ProviderId::GeminiCli => "gemini-oauth",
            ProviderId::Kimi => "kimi",
            ProviderId::OpenAiCustom => "openai-custom",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProviderId::ClaudeCode => "Anthropic (OAuth)",
            ProviderId::Codex => "Codex (OAuth)",
            ProviderId::GeminiCli => "Gemini (OAuth)",
            ProviderId::Kimi => "Kimi Code (API Key)",
            ProviderId::OpenAiCustom => "OpenAI Custom",
        }
    }

    pub fn default_model(self) -> &'static str {
        crate::models::defaults::default_model_for(self)
    }

    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "anthropic-oauth" | "claude-code" | "anthropic" => Some(ProviderId::ClaudeCode),
            "codex-oauth" | "codex" => Some(ProviderId::Codex),
            "gemini-oauth" | "gemini-cli" | "gemini" => Some(ProviderId::GeminiCli),
            "kimi" | "kimi-code" | "moonshot" => Some(ProviderId::Kimi),
            "openai-custom" => Some(ProviderId::OpenAiCustom),
            _ => None,
        }
    }
}

pub const PROVIDER_ORDER: &[ProviderId] = &[
    ProviderId::ClaudeCode,
    ProviderId::Codex,
    ProviderId::GeminiCli,
    ProviderId::Kimi,
    ProviderId::OpenAiCustom,
];

pub fn cycle(current: ProviderId, direction: i32) -> ProviderId {
    let idx = PROVIDER_ORDER
        .iter()
        .position(|p| *p == current)
        .unwrap_or(0);
    let n = PROVIDER_ORDER.len() as i32;
    let next = (((idx as i32) + direction).rem_euclid(n)) as usize;
    PROVIDER_ORDER[next]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_mapping_matches_spec_table() {
        assert_eq!(ProviderId::ClaudeCode.default_model(), "claude-opus-4-7[1m]");
        assert_eq!(ProviderId::Codex.default_model(), "gpt-5.4");
        assert_eq!(ProviderId::GeminiCli.default_model(), "gemini-3-pro-preview");
        assert_eq!(ProviderId::Kimi.default_model(), "kimi-for-coding");
        assert_eq!(ProviderId::OpenAiCustom.default_model(), "gpt-5.5");
    }

    #[test]
    fn slug_round_trips_through_from_slug() {
        for p in PROVIDER_ORDER {
            assert_eq!(ProviderId::from_slug(p.slug()), Some(*p));
        }
    }

    #[test]
    fn from_slug_unknown_returns_none() {
        assert!(ProviderId::from_slug("unknown").is_none());
        assert!(ProviderId::from_slug("").is_none());
    }

    #[test]
    fn kimi_slug_has_documented_aliases() {

        assert_eq!(ProviderId::from_slug("kimi"), Some(ProviderId::Kimi));
        assert_eq!(ProviderId::from_slug("kimi-code"), Some(ProviderId::Kimi));
        assert_eq!(ProviderId::from_slug("moonshot"), Some(ProviderId::Kimi));
    }

    #[test]
    fn cycle_wraps_forward() {
        assert_eq!(cycle(ProviderId::ClaudeCode, 1), ProviderId::Codex);
        assert_eq!(cycle(ProviderId::Codex, 1), ProviderId::GeminiCli);
        assert_eq!(cycle(ProviderId::GeminiCli, 1), ProviderId::Kimi);
        assert_eq!(cycle(ProviderId::Kimi, 1), ProviderId::OpenAiCustom);
        assert_eq!(cycle(ProviderId::OpenAiCustom, 1), ProviderId::ClaudeCode);
    }

    #[test]
    fn cycle_wraps_backward() {
        assert_eq!(cycle(ProviderId::ClaudeCode, -1), ProviderId::OpenAiCustom);
        assert_eq!(cycle(ProviderId::OpenAiCustom, -1), ProviderId::Kimi);
        assert_eq!(cycle(ProviderId::Kimi, -1), ProviderId::GeminiCli);
    }

    #[test]
    fn cmd_login_resolves_codex_slug() {
        
        assert_eq!(ProviderId::from_slug("codex"), Some(ProviderId::Codex));
        assert_eq!(ProviderId::from_slug("codex-oauth"), Some(ProviderId::Codex));
    }

}
