//! Provider registry — the four user-selectable providers exposed
//! in the Config tab's Provider row, each with a canonical default
//! model alias.
//!
//! Spec: openspec 009-settings-interactive-edit §"Provider selector".
//!
//! Today this module only exposes the metadata (slug + default
//! model). Dispatch wiring (translator + fingerprint) lands per
//! pillar archive — the freeze rule in
//! `feedback_otherside_autonomous_mode_directive.md` still holds
//! for the actual request routing code; only the USER-FACING row
//! is live now.
//!
//! Default model table per user directive 2026-04-20:
//!
//! | Provider       | Default model                 |
//! |---------------:|-------------------------------|
//! | claude-code    | `claude-opus-4-7[1m]`         |
//! | codex          | `gpt-5.4`                     |
//! | gemini-cli     | `gemini-3.1-pro-preview`      |
//! | openai-custom  | `""` (user-supplied)          |

/// User-selectable provider identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderId {
    ClaudeCode,
    Codex,
    GeminiCli,
    OpenAiCustom,
}

impl ProviderId {
    /// Stable slug used in `settings.json::defaultProvider`.
    pub fn slug(self) -> &'static str {
        match self {
            ProviderId::ClaudeCode => "claude-code",
            ProviderId::Codex => "codex",
            ProviderId::GeminiCli => "gemini-cli",
            ProviderId::OpenAiCustom => "openai-custom",
        }
    }

    /// Human label shown in the Config tab.
    pub fn label(self) -> &'static str {
        match self {
            ProviderId::ClaudeCode => "claude-code",
            ProviderId::Codex => "codex",
            ProviderId::GeminiCli => "gemini-cli",
            ProviderId::OpenAiCustom => "openai-custom",
        }
    }

    /// Canonical default model alias for this provider.
    ///
    /// Returned when the user switches Provider via the Config tab;
    /// `state.model` auto-updates to this value (the user can then
    /// override independently via the Model row).
    pub fn default_model(self) -> &'static str {
        match self {
            ProviderId::ClaudeCode => "claude-opus-4-7[1m]",
            ProviderId::Codex => "gpt-5.4",
            ProviderId::GeminiCli => "gemini-3.1-pro-preview",
            ProviderId::OpenAiCustom => "",
        }
    }

    /// Parse from a slug. Matches the exact strings emitted by
    /// `slug()`; unknown slugs return `None` (caller falls back to
    /// `ProviderId::ClaudeCode` default).
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "claude-code" => Some(ProviderId::ClaudeCode),
            "codex" => Some(ProviderId::Codex),
            "gemini-cli" => Some(ProviderId::GeminiCli),
            "openai-custom" => Some(ProviderId::OpenAiCustom),
            _ => None,
        }
    }
}

/// Canonical order used by the Provider row's cycle.
pub const PROVIDER_ORDER: &[ProviderId] = &[
    ProviderId::ClaudeCode,
    ProviderId::Codex,
    ProviderId::GeminiCli,
    ProviderId::OpenAiCustom,
];

/// Advance `current` by `direction` (±1) through `PROVIDER_ORDER`,
/// wrapping.
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
        assert_eq!(ProviderId::GeminiCli.default_model(), "gemini-3.1-pro-preview");
        assert_eq!(ProviderId::OpenAiCustom.default_model(), "");
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
    fn cycle_wraps_forward() {
        assert_eq!(cycle(ProviderId::ClaudeCode, 1), ProviderId::Codex);
        assert_eq!(cycle(ProviderId::Codex, 1), ProviderId::GeminiCli);
        assert_eq!(cycle(ProviderId::GeminiCli, 1), ProviderId::OpenAiCustom);
        assert_eq!(cycle(ProviderId::OpenAiCustom, 1), ProviderId::ClaudeCode);
    }

    #[test]
    fn cycle_wraps_backward() {
        assert_eq!(cycle(ProviderId::ClaudeCode, -1), ProviderId::OpenAiCustom);
        assert_eq!(cycle(ProviderId::OpenAiCustom, -1), ProviderId::GeminiCli);
    }

    #[test]
    fn provider_order_has_four_entries() {
        assert_eq!(PROVIDER_ORDER.len(), 4);
    }
}
