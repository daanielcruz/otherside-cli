//! Humanized model display names.
//!
//! Canonical IDs like `claude-opus-4-7` render as `Opus 4.7` in TUI
//! chrome (statusline, `/status` summary, model menu headers). Covers
//! the Opus/Sonnet/Haiku families; unknown canonical ids fall back
//! verbatim so new releases do not break rendering.
//!
//! `has_1m` appends `" (1M context)"` — see R-105. The suffix is a
//! display-only concern; the wire model id and the
//! `anthropic-beta: context-1m-2025-08-07` header are handled in
//! the translator layer.
//!
//! This helper feeds `statusline::types::ModelInput.display_name` at
//! construction time so zero-config users see a humanized name.

/// Map a canonical model id to its humanized display base. Delegates
/// to `crate::models::catalog::display_name_for` — the registry owns
/// the table. Returns `None` for unknown ids so the caller falls back
/// to the canonical verbatim.
pub fn public_model_display_name(canonical: &str) -> Option<&'static str> {
    crate::models::catalog::display_name_for(canonical)
}

/// Compose the full display name including the optional `(1M context)`
/// suffix. Falls back to the canonical id verbatim when the family is
/// unknown so new releases do not silently render as a blank string.
pub fn render_model_name(canonical: &str, has_1m: bool) -> String {
    let base = public_model_display_name(canonical).unwrap_or(canonical);
    if has_1m {
        format!("{base} (1M context)")
    } else {
        base.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_model_display_name_opus_4_7() {
        assert_eq!(public_model_display_name("claude-opus-4-7"), Some("Opus 4.7"));
    }

    #[test]
    fn public_model_display_name_sonnet_4_6() {
        assert_eq!(
            public_model_display_name("claude-sonnet-4-6"),
            Some("Sonnet 4.6")
        );
    }

    #[test]
    fn public_model_display_name_haiku_4_5() {
        assert_eq!(public_model_display_name("claude-haiku-4-5"), Some("Haiku 4.5"));
    }

    #[test]
    fn public_model_display_name_unknown_returns_none() {
        assert_eq!(public_model_display_name("claude-opus-99-9"), None);
        assert_eq!(public_model_display_name(""), None);
    }

    #[test]
    fn render_model_name_base_only() {
        assert_eq!(render_model_name("claude-opus-4-7", false), "Opus 4.7");
    }

    #[test]
    fn render_model_name_1m_suffix() {
        assert_eq!(
            render_model_name("claude-opus-4-7", true),
            "Opus 4.7 (1M context)"
        );
    }

    #[test]
    fn render_model_name_unknown_canonical_falls_back_verbatim() {
        assert_eq!(
            render_model_name("claude-opus-99-9", false),
            "claude-opus-99-9"
        );
        // 1M suffix still appends to the verbatim fallback.
        assert_eq!(
            render_model_name("claude-opus-99-9", true),
            "claude-opus-99-9 (1M context)"
        );
    }
}
