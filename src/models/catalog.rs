

use crate::config::providers::ProviderId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {

    pub id: &'static str,

    pub display_name: &'static str,

    pub supports_1m: bool,

    pub provider: ProviderId,

    pub family_alias: Option<&'static str>,

    pub primary_for_family: bool,

    pub supported_efforts: &'static [&'static str],

    pub default_effort: &'static str,

    pub context_window: u64,

    pub display_hint: &'static str,
}

pub const CATALOG: &[Model] = &[

    Model {
        id: "claude-opus-4-7[1m]",
        display_name: "Opus 4.7 (1M context)",
        supports_1m: true,
        provider: ProviderId::ClaudeCode,
        family_alias: Some("opus"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high", "xhigh", "max"],
        default_effort: "xhigh",
        context_window: 1_000_000,
        display_hint: "Opus 4.7 with 1M context · Most capable for complex work",
    },
    Model {
        id: "claude-opus-4-7",
        display_name: "Opus 4.7",
        supports_1m: true,
        provider: ProviderId::ClaudeCode,
        family_alias: Some("opus"),
        primary_for_family: true,
        supported_efforts: &["auto", "low", "medium", "high", "xhigh", "max"],
        default_effort: "xhigh",
        context_window: 200_000,
        display_hint: "Opus 4.7 · Most capable for complex work",
    },
    Model {
        id: "claude-sonnet-4-6",
        display_name: "Sonnet 4.6",
        supports_1m: true,
        provider: ProviderId::ClaudeCode,
        family_alias: Some("sonnet"),
        primary_for_family: true,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "high",
        context_window: 200_000,
        display_hint: "Sonnet 4.6 · Best for everyday tasks",
    },
    Model {
        id: "claude-haiku-4-5",
        display_name: "Haiku 4.5",
        supports_1m: true,
        provider: ProviderId::ClaudeCode,
        family_alias: Some("haiku"),
        primary_for_family: true,
        supported_efforts: &["auto"],
        default_effort: "auto",
        context_window: 200_000,
        display_hint: "Haiku 4.5 · Fastest for quick answers",
    },

    // Codex / ChatGPT OAuth account catalog.
    // Upstream removed its static preset list (see
    // `openai/codex:codex-rs/models-manager/src/model_presets.rs`) in favor
    // of a live `GET /models` fetch. We carry a small static fallback here,
    // limited to slugs the ChatGPT OAuth flow actually serves — empirically
    // probed against a live account: other `gpt-5*` slugs 400 with "not
    // supported when using Codex with a ChatGPT account".
    Model {
        id: "gpt-5.4",
        display_name: "GPT 5.4",
        supports_1m: false,
        provider: ProviderId::Codex,
        family_alias: Some("gpt-5"),
        primary_for_family: true,
        supported_efforts: &["auto", "low", "medium", "high", "xhigh"],
        default_effort: "auto",
        context_window: 272_000,
        display_hint: "GPT 5.4 · Codex default · Responses API",
    },
    Model {
        id: "gpt-5.3-codex",
        display_name: "GPT 5.3 Codex",
        supports_1m: false,
        provider: ProviderId::Codex,
        family_alias: Some("gpt-5"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high", "xhigh"],
        default_effort: "auto",
        context_window: 272_000,
        display_hint: "GPT 5.3 Codex · coding-tuned · Responses API",
    },

    Model {
        id: "gemini-3.1-pro-preview",
        display_name: "Gemini 3.1 Pro Preview",
        supports_1m: false,
        provider: ProviderId::GeminiCli,
        family_alias: None,
        primary_for_family: false,
        supported_efforts: &["auto"],
        default_effort: "auto",
        context_window: 200_000,
        display_hint: "",
    },

    Model {
        id: "kimi-for-coding",
        display_name: "Kimi K2.6",
        supports_1m: false,
        provider: ProviderId::Kimi,
        family_alias: Some("kimi"),
        primary_for_family: true,
        // Kimi reasoning is binary: `thinking: {type:"adaptive"}` envelope
        // rides when on, strips when off. Probe 2026-04-22 against
        // api.kimi.com/coding/v1/models returned a single row — the
        // previously-listed `kimi-k2-thinking` ghost is rejected by the
        // backend and has been removed.
        supported_efforts: &["on", "off"],
        default_effort: "on",
        context_window: 262_144,
        display_hint: "Kimi K2.6 · 262k window · anthropic-compatible",
    },
];

pub fn by_id(id: &str) -> Option<&'static Model> {
    CATALOG.iter().find(|m| m.id == id)
}

pub fn display_name_for(id: &str) -> Option<&'static str> {
    by_id(id).map(|m| m.display_name)
}

pub fn has_1m_suffix(id: &str) -> bool {
    id.to_ascii_lowercase().contains("[1m]")
}

pub fn models_for(provider: ProviderId) -> Vec<&'static Model> {
    CATALOG.iter().filter(|m| m.provider == provider).collect()
}

pub fn default_effort_for(id: &str) -> &'static str {
    by_id(id).map(|m| m.default_effort).unwrap_or("auto")
}

pub fn context_window_for(id: &str) -> u64 {
    if let Some(m) = by_id(id) {
        return m.context_window;
    }
    if has_1m_suffix(id) {
        return 1_000_000;
    }
    200_000
}

pub fn supports_effort(id: &str, effort: &str) -> bool {
    match by_id(id) {
        Some(m) => m.supported_efforts.contains(&effort),
        None => effort == "auto",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_non_1m_is_primary_for_opus_family() {

        let opus_bare = by_id("claude-opus-4-7").expect("opus in catalog");
        assert!(opus_bare.primary_for_family);
        let opus_1m = by_id("claude-opus-4-7[1m]").expect("opus 1m in catalog");
        assert!(!opus_1m.primary_for_family);
    }

    #[test]
    fn sonnet_and_haiku_have_single_primary() {
        let sonnet = by_id("claude-sonnet-4-6").expect("sonnet");
        assert!(sonnet.primary_for_family);
        let haiku = by_id("claude-haiku-4-5").expect("haiku");
        assert!(haiku.primary_for_family);
    }

    #[test]
    fn display_name_resolves_for_opus() {
        assert_eq!(display_name_for("claude-opus-4-7"), Some("Opus 4.7"));
        assert_eq!(
            display_name_for("claude-opus-4-7[1m]"),
            Some("Opus 4.7 (1M context)"),
            "the 1M variant carries a distinct label; `model_display_label` used to synthesize this, now catalog owns it"
        );
    }

    #[test]
    fn display_name_none_for_unknown() {
        assert!(display_name_for("gpt-foo-bar").is_none());
    }

    #[test]
    fn models_for_claude_code_lists_three_families() {
        let ms = models_for(ProviderId::ClaudeCode);
        let families: Vec<Option<&'static str>> =
            ms.iter().map(|m| m.family_alias).collect();
        assert!(families.contains(&Some("opus")));
        assert!(families.contains(&Some("sonnet")));
        assert!(families.contains(&Some("haiku")));
    }

    #[test]
    fn codex_has_gpt54() {
        let ms = models_for(ProviderId::Codex);
        assert!(ms.iter().any(|m| m.id == "gpt-5.4"));
    }

    #[test]
    fn codex_catalog_carries_the_two_oauth_servable_slugs() {
        // ChatGPT OAuth backend only serves gpt-5.4 and gpt-5.3-codex today;
        // other gpt-5* slugs return {"detail":"… model is not supported
        // when using Codex with a ChatGPT account."}. Keep the catalog pinned
        // to what actually works until we wire a live /models fetch.
        let ms = models_for(ProviderId::Codex);
        let slugs: Vec<&str> = ms.iter().map(|m| m.id).collect();
        assert!(slugs.contains(&"gpt-5.4"), "{slugs:?}");
        assert!(slugs.contains(&"gpt-5.3-codex"), "{slugs:?}");
        let primary = ms.iter().find(|m| m.primary_for_family).unwrap();
        assert_eq!(primary.id, "gpt-5.4", "gpt-5.4 is the default model slug");
    }

    #[test]
    fn kimi_single_row_is_for_coding() {
        // Live probe 2026-04-22 against api.kimi.com/coding/v1/models
        // returned exactly one row — `kimi-for-coding`. The previously-
        // shipped `kimi-k2-thinking` slug was a ghost the backend refuses;
        // dropping it keeps /model panel honest.
        let ms = models_for(ProviderId::Kimi);
        assert_eq!(ms.len(), 1, "kimi catalog ships only kimi-for-coding");
        let primary = ms.iter().find(|m| m.primary_for_family).unwrap();
        assert_eq!(primary.id, "kimi-for-coding");
        assert_eq!(primary.display_name, "Kimi K2.6");
        assert!(!ms.iter().any(|m| m.id == "kimi-k2-thinking"));
    }

    #[test]
    fn kimi_reasoning_is_binary_on_off() {
        // Kimi wire: effort=on keeps `thinking:{type:"adaptive"}` envelope,
        // effort=off strips thinking + context_management. No numeric
        // levels (anthropic's low/medium/high/xhigh/max don't apply).
        let ms = models_for(ProviderId::Kimi);
        for m in ms {
            assert_eq!(m.context_window, 262_144);
            assert!(!m.supports_1m);
            assert_eq!(m.supported_efforts, &["on", "off"]);
            assert_eq!(m.default_effort, "on");
        }
    }

    #[test]
    fn has_1m_suffix_detects_case_insensitively() {
        assert!(has_1m_suffix("claude-opus-4-7[1m]"));
        assert!(has_1m_suffix("claude-opus-4-7[1M]"));
        assert!(!has_1m_suffix("claude-opus-4-7"));
    }
}
