

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationWarning {
    pub scope: Scope,
    pub kind: WarningKind,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    UserGlobal,
    ProjectLocal,
    Flag,
    Policy,
    McpChain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarningKind {

    InvalidPermissionRule,

    UnknownTopLevelKey,

    LegacyValueMigrated,

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

}
