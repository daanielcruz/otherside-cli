//! Per-agent default model. Upstream agent frontmatter accepts
//! `model: inherit` to inherit the parent session's model; concrete
//! ids pin the agent to a specific choice regardless of what the
//! parent is using.
//!
//! This module answers: "what model should subagent `<name>` run on?"
//!
//! Resolution order (runner calls this with the agent's frontmatter
//! value + the parent session's model):
//! 1. Explicit `invocation.model` wins (the Agent call carried a
//!    `model:` parameter).
//! 2. Frontmatter `model: <concrete-id-or-family-alias>` resolves
//!    via `aliases::resolve` and wins.
//! 3. Frontmatter `model: inherit` or absent → parent session model.
//! 4. Parent session model itself passes through `aliases::resolve`
//!    so family aliases work at the outer layer too.

use super::aliases;

/// Literal string upstream uses for "inherit from parent session".
pub const INHERIT_SENTINEL: &str = "inherit";

/// Resolve the final wire id for a subagent invocation.
///
/// `invocation_model` is the `model:` arg the caller passed (if any).
/// `frontmatter_model` is the agent's `model:` frontmatter (if any).
/// `parent_model` is the model the parent session is using.
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
        // Parent session running a bare `opus` alias — resolves to
        // non-1M per upstream. Max-bias is not the resolver's job.
        assert_eq!(
            resolve_agent_model(None, Some("inherit"), "opus"),
            "claude-opus-4-7"
        );
    }
}
