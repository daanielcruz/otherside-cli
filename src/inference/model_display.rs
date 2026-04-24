

pub fn public_model_display_name(canonical: &str) -> Option<&'static str> {
    crate::models::catalog::display_name_for(canonical)
}

pub fn resolve_model_label(canonical: &str) -> String {
    if let Some(s) = crate::models::catalog::display_name_for(canonical) {
        return s.to_string();
    }
    let live = crate::provider::codex_models::cached_models();
    if live.iter().any(|m| m.slug == canonical) {
        return crate::provider::codex_models::display_codex_name(canonical);
    }
    canonical.to_string()
}

pub fn render_model_name(canonical: &str, has_1m: bool) -> String {
    let base = resolve_model_label(canonical);
    if has_1m {
        format!("{base} (1M context)")
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        assert_eq!(
            render_model_name("claude-opus-99-9", true),
            "claude-opus-99-9 (1M context)"
        );
    }
}
