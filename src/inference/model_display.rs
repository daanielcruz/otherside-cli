

pub fn public_model_display_name(canonical: &str) -> Option<&'static str> {
    crate::models::catalog::display_name_for(canonical)
}

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

        assert_eq!(
            render_model_name("claude-opus-99-9", true),
            "claude-opus-99-9 (1M context)"
        );
    }
}
