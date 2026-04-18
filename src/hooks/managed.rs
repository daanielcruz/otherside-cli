//! Managed-hooks-only gate.
//!
//! Policy-tier settings may set `allowManagedHooksOnly = true`,
//! which restricts hook execution to entries whose `source_tag`
//! (set during config resolution) is `policy`. User-authored hooks
//! are silently dropped with a one-time warning.
//!
//! The `HookEntry` struct (in config::settings) carries an optional
//! `source_tag` field populated during resolve; this gate checks it.

use crate::config::settings::HookEntry;

pub fn should_run(entry: &HookEntry, allow_managed_only: bool) -> bool {
    if !allow_managed_only {
        return true;
    }
    matches!(entry.source_tag.as_deref(), Some("policy"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::HookEntry;

    #[test]
    fn gate_off_runs_everything() {
        let e = HookEntry {
            matcher: "*".into(),
            command: "echo".into(),
            ..Default::default()
        };
        assert!(should_run(&e, false));
    }

    #[test]
    fn gate_on_drops_user_hooks() {
        let e = HookEntry {
            matcher: "*".into(),
            command: "echo".into(),
            source_tag: None,
            ..Default::default()
        };
        assert!(!should_run(&e, true));
    }

    #[test]
    fn gate_on_keeps_policy_hooks() {
        let e = HookEntry {
            matcher: "*".into(),
            command: "echo".into(),
            source_tag: Some("policy".into()),
            ..Default::default()
        };
        assert!(should_run(&e, true));
    }
}
