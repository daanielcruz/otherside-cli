//! Per-model facts table. Canonical ids + display strings + 1M context
//! support flag, keyed by provider. Single source of truth imported by
//! statusline / subagent alias resolver / `/model` picker / agent
//! frontmatter loader.
//!
//! When a new model lands upstream, add one entry here. Consumers
//! reading `display_name` or `supports_1m` stay in sync automatically.

use crate::config::providers::ProviderId;

/// One row of the model catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    /// Wire id (what ships on `model:` in the outgoing request body).
    pub id: &'static str,
    /// Human-readable display name shown in statusline / picker.
    pub display_name: &'static str,
    /// True when a `[1m]` suffix variant exists on the wire.
    pub supports_1m: bool,
    /// Owning provider.
    pub provider: ProviderId,
    /// Family alias that resolves to this row when the user types the
    /// short name (`opus`, `sonnet`, `haiku`). `None` for non-aliased
    /// entries (e.g. provider-specific ids with no short form).
    pub family_alias: Option<&'static str>,
    /// When `true` this row is the preferred landing for the family
    /// alias. For opus we set this on the `[1m]` variant so bare `opus`
    /// → opus 1M (Max subscriber default).
    pub primary_for_family: bool,
    /// Effort levels this model accepts on the wire. Subset of
    /// `["auto", "low", "medium", "high", "xhigh", "max"]`. Models
    /// without explicit effort support (haiku) carry `["auto"]` only.
    pub supported_efforts: &'static [&'static str],
    /// Effort level applied at session start when the user has no
    /// override. `"auto"` for models without explicit effort support.
    pub default_effort: &'static str,
}

/// Every model otherside knows about. Ordered roughly by
/// provider then capability (opus > sonnet > haiku).
pub const CATALOG: &[Model] = &[
    // Anthropic / claude-code provider.
    // `primary_for_family` sits on the NON-1M row per upstream
    // `parseUserSpecifiedModel`: bare `opus` → `claude-opus-4-7`
    // without `[1m]`. The 1M suffix is a separate alias path
    // (`opus[1m]`). Tier-aware default (Max / Team Premium) flips to
    // the `[1m]` variant upstream of the resolver — see
    // `defaults::default_claude_code_for_tier`.
    Model {
        id: "claude-opus-4-7",
        display_name: "Opus 4.7",
        supports_1m: true,
        provider: ProviderId::ClaudeCode,
        family_alias: Some("opus"),
        primary_for_family: true,
        supported_efforts: &["auto", "low", "medium", "high", "xhigh", "max"],
        default_effort: "xhigh",
    },
    Model {
        id: "claude-opus-4-7[1m]",
        display_name: "Opus 4.7",
        supports_1m: true,
        provider: ProviderId::ClaudeCode,
        family_alias: Some("opus"),
        primary_for_family: false,
        supported_efforts: &["auto", "low", "medium", "high", "xhigh", "max"],
        default_effort: "xhigh",
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
    },
    // Codex / OpenAI provider (dispatch frozen, catalog still exposed for
    // the picker row when the user selects this provider)
    Model {
        id: "gpt-5.4",
        display_name: "GPT 5.4",
        supports_1m: false,
        provider: ProviderId::Codex,
        family_alias: None,
        primary_for_family: false,
        supported_efforts: &["auto"],
        default_effort: "auto",
    },
    // Gemini / Google provider (dispatch frozen)
    Model {
        id: "gemini-3.1-pro-preview",
        display_name: "Gemini 3.1 Pro Preview",
        supports_1m: false,
        provider: ProviderId::GeminiCli,
        family_alias: None,
        primary_for_family: false,
        supported_efforts: &["auto"],
        default_effort: "auto",
    },
];

/// Lookup by exact wire id.
pub fn by_id(id: &str) -> Option<&'static Model> {
    CATALOG.iter().find(|m| m.id == id)
}

/// Display name for a raw model id. Returns `None` when the id is not
/// in the catalog; callers render the id verbatim in that case.
pub fn display_name_for(id: &str) -> Option<&'static str> {
    by_id(id).map(|m| m.display_name)
}

/// True if `id` is a `[1m]`-suffixed variant.
pub fn has_1m_suffix(id: &str) -> bool {
    id.to_ascii_lowercase().contains("[1m]")
}

/// Every model belonging to `provider`, in catalog order.
pub fn models_for(provider: ProviderId) -> Vec<&'static Model> {
    CATALOG.iter().filter(|m| m.provider == provider).collect()
}

/// Default effort level for the given model id — `default_effort`
/// when the model is in the catalog, otherwise `"auto"`.
pub fn default_effort_for(id: &str) -> &'static str {
    by_id(id).map(|m| m.default_effort).unwrap_or("auto")
}

/// True iff `effort` is a valid level for `id`. Unknown ids only
/// accept `"auto"`.
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
        // Upstream bare `opus` resolves to non-1M. The Max-subscriber
        // bias that flips to 1M lives in `defaults`, not here.
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
    fn codex_has_gpt54() {
        let ms = models_for(ProviderId::Codex);
        assert!(ms.iter().any(|m| m.id == "gpt-5.4"));
    }

    #[test]
    fn has_1m_suffix_detects_case_insensitively() {
        assert!(has_1m_suffix("claude-opus-4-7[1m]"));
        assert!(has_1m_suffix("claude-opus-4-7[1M]"));
        assert!(!has_1m_suffix("claude-opus-4-7"));
    }
}
