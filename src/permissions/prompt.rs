//! Permission prompt choices + scopes.
//!
//! Rendering the actual modal is TUI-surface (`tui::permission_prompt`);
//! this module just owns the shared types so tests + the TUI can
//! agree on the vocabulary.

/// What the user picked when prompted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptChoice {
    Yes,
    No,
    AlwaysAllow(AllowScope),
}

/// Where to persist an `AlwaysAllow` rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllowScope {
    /// `./.otherside/settings.json` (project-local).
    ProjectLocal,
    /// `~/.otherside/settings.json` (user-global).
    UserGlobal,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choice_variants_debug() {
        assert_eq!(format!("{:?}", PromptChoice::Yes), "Yes");
        assert_eq!(format!("{:?}", AllowScope::UserGlobal), "UserGlobal");
    }
}
