//! Validation errors and warnings surfaced by the config layer.
//!
//! Why two channels: some invalid inputs must block the load
//! (malformed JSON, wrong top-level type) and some must drop-and-
//! continue (one bad permission rule in a list of good ones). The
//! first set surfaces as `Error::Config`; the second accumulates as
//! `ValidationWarning` attached to the successful load so callers
//! can log them without failing the startup path.

use std::fmt;

/// A validation issue that does NOT fail the config load — the
/// offending value was dropped or normalized and the rest is usable.
/// Callers (typically `main.rs`) print warnings to stderr after a
/// successful `load_all()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationWarning {
    pub scope: Scope,
    pub kind: WarningKind,
    pub detail: String,
}

/// Which of the five precedence scopes produced the warning. Policy
/// warnings surface separately because admin-authored drift matters
/// more than a user typo in their own file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    UserGlobal,
    ProjectLocal,
    Flag,
    Policy,
    McpChain,
}

/// Categorical reason for the warning. Keep the set small — callers
/// group-by kind when aggregating for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarningKind {
    /// A permission rule missing `toolName` or `matchPattern` was
    /// dropped; the remaining rules still applied.
    InvalidPermissionRule,
    /// An unknown top-level key survived via `extra`; we flag it so
    /// the user can spot typos.
    UnknownTopLevelKey,
    /// A legacy key or value was auto-migrated. Informational only.
    LegacyValueMigrated,
    /// An `OTHERSIDE_*` env var that looked like a per-field override
    /// was ignored (config is file-only).
    IgnoredShadowEnv,
}

impl fmt::Display for ValidationWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let scope = match self.scope {
            Scope::UserGlobal => "user-global settings",
            Scope::ProjectLocal => "project-local settings",
            Scope::Flag => "CLI flags",
            Scope::Policy => "managed policy",
            Scope::McpChain => ".mcp.json",
        };
        let kind = match self.kind {
            WarningKind::InvalidPermissionRule => "invalid permission rule dropped",
            WarningKind::UnknownTopLevelKey => "unknown top-level key preserved",
            WarningKind::LegacyValueMigrated => "legacy value migrated",
            WarningKind::IgnoredShadowEnv => "env var ignored",
        };
        write!(f, "[{scope}] {kind}: {}", self.detail)
    }
}

impl ValidationWarning {
    pub fn new(scope: Scope, kind: WarningKind, detail: impl Into<String>) -> Self {
        Self {
            scope,
            kind,
            detail: detail.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_renders_scope_and_kind() {
        let w = ValidationWarning::new(
            Scope::UserGlobal,
            WarningKind::InvalidPermissionRule,
            "rule missing toolName",
        );
        let s = format!("{w}");
        assert!(s.contains("user-global"));
        assert!(s.contains("invalid permission rule"));
        assert!(s.contains("missing toolName"));
    }

    #[test]
    fn scope_kind_equality_works_for_filtering() {
        let a = ValidationWarning::new(
            Scope::Policy,
            WarningKind::IgnoredShadowEnv,
            "OTHERSIDE_PERMISSION_MODE ignored",
        );
        let b = a.clone();
        assert_eq!(a, b);
    }
}
