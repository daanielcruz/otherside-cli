//! Alias resolver — maps short family names (`opus`, `sonnet`, `haiku`,
//! `opus[1m]`, …) to concrete catalog ids. Mirrors upstream
//! `utils/model/model.ts::parseUserSpecifiedModel`.
//!
//! Rules:
//! - Bare `opus` → `claude-opus-4-7[1m]` (Max subscriber default, the
//!   `primary_for_family` row in the catalog).
//! - Bare `sonnet` / `haiku` → non-1M primary row.
//! - `[1m]` suffix carried across the alias boundary when the family
//!   has a 1M variant. Unknown suffix → pass through verbatim.
//! - Non-family strings pass through verbatim so raw wire ids and
//!   provider-specific names still work.

use super::catalog::{self, Model};

/// Resolve a user-supplied model string (alias or raw id) to the
/// concrete wire id otherside should send.
pub fn resolve(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let (base, explicit_1m) = strip_1m_suffix(&lower);

    // First try exact id match (includes catalog rows that are
    // `[1m]`-suffixed themselves).
    if catalog::by_id(raw).is_some() {
        return raw.to_string();
    }
    if catalog::by_id(&lower).is_some() {
        return lower;
    }

    // Family alias path — find the primary row for this family, then
    // flip to the alternate variant if the user's suffix disagrees
    // with the primary's 1M flag.
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

/// Split trailing `[1m]` off a lowered model string.
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
        // Upstream-faithful: bare `opus` → non-1M. The Max-subscriber
        // bias lives in `defaults::default_claude_code_for_tier`, not
        // in the resolver. Callers that want 1M pass `opus[1m]`
        // explicitly or feed the tier-aware default upstream.
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
        // No sonnet[1m] row in catalog today; resolver returns primary.
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
