

use super::aliases;

pub const INHERIT_SENTINEL: &str = "inherit";

pub fn resolve_agent_model(
    invocation_model: Option<&str>,
    frontmatter_model: Option<&str>,
    parent_model: &str,
) -> String {
    if let Some(m) = invocation_model {
        return aliases::resolve(m);
    }
    match frontmatter_model {
        Some(m) if m == INHERIT_SENTINEL || m.is_empty() => aliases::resolve(parent_model),
        Some(m) => aliases::resolve(m),
        None => aliases::resolve(parent_model),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invocation_wins_over_frontmatter() {
        assert_eq!(
            resolve_agent_model(Some("haiku"), Some("opus"), "claude-sonnet-4-6"),
            "claude-haiku-4-5"
        );
    }

    #[test]
    fn frontmatter_used_when_no_invocation() {
        assert_eq!(
            resolve_agent_model(None, Some("sonnet"), "claude-opus-4-7[1m]"),
            "claude-sonnet-4-6"
        );
    }

    #[test]
    fn inherit_sentinel_falls_back_to_parent() {
        assert_eq!(
            resolve_agent_model(None, Some("inherit"), "claude-opus-4-7[1m]"),
            "claude-opus-4-7[1m]"
        );
    }

    #[test]
    fn no_frontmatter_falls_back_to_parent() {
        assert_eq!(
            resolve_agent_model(None, None, "claude-opus-4-7[1m]"),
            "claude-opus-4-7[1m]"
        );
    }

    #[test]
    fn parent_alias_gets_resolved() {

        assert_eq!(
            resolve_agent_model(None, Some("inherit"), "opus"),
            "claude-opus-4-7"
        );
    }
}
