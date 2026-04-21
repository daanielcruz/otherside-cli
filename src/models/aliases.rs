

use super::catalog::{self, Model};

pub fn resolve(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let (base, explicit_1m) = strip_1m_suffix(&lower);

    if catalog::by_id(raw).is_some() {
        return raw.to_string();
    }
    if catalog::by_id(&lower).is_some() {
        return lower;
    }

    if let Some(primary) = primary_by_family(&base) {
        let primary_is_1m = catalog::has_1m_suffix(primary.id);
        if explicit_1m == primary_is_1m {
            return primary.id.to_string();
        }
        if let Some(alt) = alternate_for_family(&base, explicit_1m) {
            return alt.id.to_string();
        }
        return primary.id.to_string();
    }

    raw.to_string()
}

fn strip_1m_suffix(lower: &str) -> (String, bool) {
    if let Some(base) = lower.strip_suffix("[1m]") {
        (base.trim().to_string(), true)
    } else {
        (lower.to_string(), false)
    }
}

fn primary_by_family(family: &str) -> Option<&'static Model> {
    catalog::CATALOG
        .iter()
        .find(|m| m.family_alias == Some(family) && m.primary_for_family)
}

fn alternate_for_family(family: &str, want_1m: bool) -> Option<&'static Model> {
    catalog::CATALOG
        .iter()
        .find(|m| m.family_alias == Some(family) && catalog::has_1m_suffix(m.id) == want_1m)
}

#[cfg(test)]
mod tests {
    use super::resolve;

    #[test]
    fn bare_opus_is_non_1m() {

        assert_eq!(resolve("opus"), "claude-opus-4-7");
    }

    #[test]
    fn explicit_opus_1m_resolves_to_1m() {
        assert_eq!(resolve("opus[1m]"), "claude-opus-4-7[1m]");
    }

    #[test]
    fn raw_opus_non_1m_passes_through() {
        assert_eq!(resolve("claude-opus-4-7"), "claude-opus-4-7");
    }

    #[test]
    fn sonnet_bare_has_no_1m() {
        assert_eq!(resolve("sonnet"), "claude-sonnet-4-6");
    }

    #[test]
    fn sonnet_1m_would_fallback_to_primary_without_alt_row() {

        assert_eq!(resolve("sonnet[1m]"), "claude-sonnet-4-6");
    }

    #[test]
    fn haiku_bare_is_primary() {
        assert_eq!(resolve("haiku"), "claude-haiku-4-5");
    }

    #[test]
    fn unknown_alias_passes_through() {
        assert_eq!(resolve("gpt-5.4"), "gpt-5.4");
        assert_eq!(resolve("gemini-3.1-pro-preview"), "gemini-3.1-pro-preview");
    }

    #[test]
    fn raw_id_1m_passes_through_unchanged() {
        assert_eq!(resolve("claude-opus-4-7[1m]"), "claude-opus-4-7[1m]");
    }

    #[test]
    fn case_insensitive_input_normalizes() {
        assert_eq!(resolve("OPUS"), "claude-opus-4-7");
        assert_eq!(resolve("Opus[1M]"), "claude-opus-4-7[1m]");
    }
}
