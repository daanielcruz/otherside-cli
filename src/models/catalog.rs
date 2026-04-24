
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
        display_name: "Opus 4.7",
        supports_1m: true,
        provider: ProviderId::ClaudeCode,
        family_alias: Some("opus"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high", "xhigh", "max"],
        default_effort: "xhigh",
        context_window: 1_000_000,
        display_hint: "Opus 4.7 · 1M context",
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
        display_hint: "Opus 4.7 · 200k context",
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
        display_hint: "Sonnet 4.6 · 200k context",
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
        display_hint: "Haiku 4.5 · 200k context",
    },

    Model {
        id: "gpt-5.4",
        display_name: "GPT 5.4",
        supports_1m: true,
        provider: ProviderId::Codex,
        family_alias: Some("gpt-5"),
        primary_for_family: true,
        // Codex never carries a `max` tier — `/responses` rejects it. Default
        // to `xhigh` so users land on the strongest available effort.
        supported_efforts: &["auto", "low", "medium", "high", "xhigh"],
        default_effort: "xhigh",
        context_window: 1_000_000,
        display_hint: "GPT 5.4 · 1M context",
    },
    Model {
        id: "gpt-5.3-codex",
        display_name: "GPT 5.3 Codex",
        supports_1m: false,
        provider: ProviderId::Codex,
        family_alias: Some("gpt-5"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high", "xhigh"],
        default_effort: "xhigh",
        context_window: 272_000,
        display_hint: "GPT 5.3 Codex · 272k context",
    },

    Model {
        id: "gemini-3-pro-preview",
        display_name: "Gemini 3 Pro Preview",
        supports_1m: true,
        provider: ProviderId::GeminiCli,
        family_alias: Some("gemini-3"),
        primary_for_family: true,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "high",
        context_window: 1_000_000,
        display_hint: "Gemini 3 Pro Preview · 1M context",
    },
    Model {
        id: "gemini-3.1-pro-preview",
        display_name: "Gemini 3.1 Pro Preview",
        supports_1m: true,
        provider: ProviderId::GeminiCli,
        family_alias: Some("gemini-3"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "high",
        context_window: 1_000_000,
        display_hint: "Gemini 3.1 Pro Preview · 1M context",
    },
    Model {
        id: "gemini-3-flash-preview",
        display_name: "Gemini 3 Flash Preview",
        supports_1m: true,
        provider: ProviderId::GeminiCli,
        family_alias: Some("gemini-3"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "medium",
        context_window: 1_000_000,
        display_hint: "Gemini 3 Flash Preview · 1M context",
    },
    Model {
        id: "gemini-3.1-flash-lite-preview",
        display_name: "Gemini 3.1 Flash Lite Preview",
        supports_1m: false,
        provider: ProviderId::GeminiCli,
        family_alias: Some("gemini-3"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "medium",
        context_window: 1_000_000,
        display_hint: "Gemini 3.1 Flash Lite · 1M context",
    },
    Model {
        id: "gemini-3.1-pro-preview-customtools",
        display_name: "Gemini 3.1 Pro Preview (custom tools)",
        supports_1m: false,
        provider: ProviderId::GeminiCli,
        family_alias: Some("gemini-3"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "medium",
        context_window: 1_000_000,
        display_hint: "Gemini 3.1 Pro Preview customtools · 1M context",
    },
    Model {
        id: "gemini-2.5-pro",
        display_name: "Gemini 2.5 Pro",
        supports_1m: true,
        provider: ProviderId::GeminiCli,
        family_alias: Some("gemini-2"),
        primary_for_family: true,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "high",
        context_window: 2_000_000,
        display_hint: "Gemini 2.5 Pro · 2M context",
    },
    Model {
        id: "gemini-2.5-flash",
        display_name: "Gemini 2.5 Flash",
        supports_1m: true,
        provider: ProviderId::GeminiCli,
        family_alias: Some("gemini-2"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "medium",
        context_window: 1_000_000,
        display_hint: "Gemini 2.5 Flash · 1M context",
    },
    Model {
        id: "gemini-2.5-flash-lite",
        display_name: "Gemini 2.5 Flash Lite",
        supports_1m: false,
        provider: ProviderId::GeminiCli,
        family_alias: Some("gemini-2"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high"],
        default_effort: "medium",
        context_window: 1_000_000,
        display_hint: "Gemini 2.5 Flash Lite · 1M context",
    },

    Model {
        id: "kimi-for-coding",
        display_name: "Kimi K2.6",
        supports_1m: false,
        provider: ProviderId::Kimi,
        family_alias: Some("kimi"),
        primary_for_family: true,
        
        supported_efforts: &["on", "off"],
        default_effort: "on",
        context_window: 262_144,
        display_hint: "Kimi K2.6 · 262k context",
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

pub fn default_effort_for_static(id: &str) -> Option<&'static str> {
    by_id(id).map(|m| m.default_effort)
}

/// Single source of truth for the user-selectable effort scale per model.
/// Strips the `auto` entry (selectable only as an implicit default) and
/// falls back to a provider-inferred scale when the id isn't in the
/// hardcoded catalog yet (live codex slugs the /models fetch returned
/// at boot but we haven't pinned locally).
pub fn effort_levels_for_model(model_id: &str) -> &'static [&'static str] {
    if let Some(m) = by_id(model_id) {
        let filtered: Vec<&'static str> = m
            .supported_efforts
            .iter()
            .copied()
            .filter(|l| *l != "auto")
            .collect();
        if !filtered.is_empty() {
            return Box::leak(filtered.into_boxed_slice());
        }
    }
    effort_levels_for_family(family_alias_from_slug(model_id))
}

/// Provider/family fallback when the model id isn't cataloged.
/// Covers the "live fetch returned a slug we never baked in" case.
pub fn effort_levels_for_family(
    family_alias: Option<&'static str>,
) -> &'static [&'static str] {
    match family_alias {
        // Codex: `/responses` rejects `max`. 4-position ladder.
        Some("gpt-5") => &["low", "medium", "high", "xhigh"],
        // Claude Sonnet caps at high per upstream; Opus adds xhigh + max;
        // Haiku has no effort scale. Without a more specific hint we return
        // the full Opus set so the picker renders a full ladder.
        Some("opus") => &["low", "medium", "high", "xhigh", "max"],
        Some("sonnet") => &["low", "medium", "high"],
        Some("haiku") => &["auto"],
        // Kimi: binary thinking on/off — keep as the only choice.
        Some("kimi") => &["on", "off"],
        _ => &["low", "medium", "high", "xhigh"],
    }
}

fn family_alias_from_slug(model_id: &str) -> Option<&'static str> {
    let lower = model_id.to_ascii_lowercase();
    if lower.starts_with("gpt-5") {
        Some("gpt-5")
    } else if lower.starts_with("claude-opus") {
        Some("opus")
    } else if lower.starts_with("claude-sonnet") {
        Some("sonnet")
    } else if lower.starts_with("claude-haiku") {
        Some("haiku")
    } else if lower.starts_with("kimi-") {
        Some("kimi")
    } else {
        None
    }
}

pub fn context_window_for(id: &str) -> u64 {
    if let Some(ctx) = crate::provider::codex_models::resolved_context_window(id) {
        return ctx;
    }
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
        assert_eq!(display_name_for("claude-opus-4-7[1m]"), Some("Opus 4.7"));
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
    fn codex_catalog_carries_the_two_oauth_servable_slugs() {
        
        let ms = models_for(ProviderId::Codex);
        let slugs: Vec<&str> = ms.iter().map(|m| m.id).collect();
        assert!(slugs.contains(&"gpt-5.4"), "{slugs:?}");
        assert!(slugs.contains(&"gpt-5.3-codex"), "{slugs:?}");
        let primary = ms.iter().find(|m| m.primary_for_family).unwrap();
        assert_eq!(primary.id, "gpt-5.4", "gpt-5.4 is the default model slug");
    }

    #[test]
    fn kimi_single_row_is_for_coding() {
        
        let ms = models_for(ProviderId::Kimi);
        assert_eq!(ms.len(), 1, "kimi catalog ships only kimi-for-coding");
        let primary = ms.iter().find(|m| m.primary_for_family).unwrap();
        assert_eq!(primary.id, "kimi-for-coding");
        assert_eq!(primary.display_name, "Kimi K2.6");
        assert!(!ms.iter().any(|m| m.id == "kimi-k2-thinking"));
    }

    #[test]
    fn kimi_reasoning_is_binary_on_off() {
        
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
