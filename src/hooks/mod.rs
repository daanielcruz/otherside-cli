//! Hooks — user-defined shell commands fired at well-known lifecycle
//! events. Event names + env-var contract are byte-verbatim upstream
//! (HARNESS fidelity — user scripts rely on them).
//!
//! # Events
//!
//! - `PreToolUse` — before a tool dispatches. env: TOOL_NAME, TOOL_INPUT
//! - `PostToolUse` — after a tool returns. env: TOOL_NAME, TOOL_INPUT,
//!   TOOL_EXIT
//! - `UserPromptSubmit` — user hit Enter on a fresh prompt. env:
//!   PROMPT_TEXT
//! - `Stop` — end of turn (final assistant message committed). env:
//!   SESSION_ID
//! - `SubagentStop` — Task subagent ended. env: SESSION_ID,
//!   SUBAGENT_ID
//! - `PreCompact` — transcript compaction about to start. env:
//!   SESSION_ID, TRANSCRIPT_PATH
//!
//! MVP semantics: advisory. Non-zero exit does NOT block the tool;
//! outputs are captured for diagnostics only.

pub mod events;
pub mod exec;
pub mod managed;

pub use events::{Event, EventCtx, PreToolUseCtx, PostToolUseCtx, UserPromptSubmitCtx};

use crate::config::settings::{HookEntry, HooksConfig};

/// Outcome of firing a single hook entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookOutcome {
    Ok {
        stdout: String,
        stderr: String,
        exit: i32,
    },
    NonZeroExit {
        code: i32,
        stdout: String,
        stderr: String,
    },
    Timeout,
    SpawnFailed(String),
}

/// Fire every hook registered for `event` whose matcher accepts the
/// given context. Returns per-entry outcomes in registration order.
///
/// Managed-hooks-only gating (`settings.allowManagedHooksOnly`) is
/// applied per-entry — entries with `source != Policy` are skipped.
pub async fn fire(
    event: Event,
    ctx: &EventCtx,
    hooks: &HooksConfig,
    allow_managed_only: bool,
) -> Vec<(HookEntry, HookOutcome)> {
    let entries: &[HookEntry] = match event {
        Event::PreToolUse => &hooks.pre_tool_use,
        Event::PostToolUse => &hooks.post_tool_use,
        Event::UserPromptSubmit => &hooks.user_prompt_submit,
        Event::Stop => &hooks.stop,
        Event::SubagentStop => &hooks.subagent_stop,
        Event::PreCompact => &hooks.pre_compact,
    };
    let mut out = Vec::new();
    for entry in entries {
        if !matcher_accepts(entry, ctx) {
            continue;
        }
        if !managed::should_run(entry, allow_managed_only) {
            continue;
        }
        let outcome = exec::fire_entry(entry, ctx, entry.timeout_ms()).await;
        out.push((entry.clone(), outcome));
    }
    out
}

fn matcher_accepts(entry: &HookEntry, ctx: &EventCtx) -> bool {
    let matcher = entry.matcher.trim();
    if matcher.is_empty() || matcher == "*" {
        return true;
    }
    match ctx {
        EventCtx::PreToolUse(c) => matcher == c.tool_name,
        EventCtx::PostToolUse(c) => matcher == c.tool_name,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::HookEntry;

    fn entry(matcher: &str, command: &str) -> HookEntry {
        HookEntry {
            matcher: matcher.to_string(),
            command: command.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn matcher_star_matches_anything() {
        let e = entry("*", "echo hi");
        let ctx = EventCtx::Stop(events::StopCtx {
            session_id: "s".into(),
        });
        assert!(matcher_accepts(&e, &ctx));
    }

    #[test]
    fn matcher_bash_matches_bash_context() {
        let e = entry("Bash", "echo hi");
        let ctx = EventCtx::PreToolUse(PreToolUseCtx {
            tool_name: "Bash".into(),
            tool_input: String::new(),
        });
        assert!(matcher_accepts(&e, &ctx));
    }

    #[test]
    fn matcher_bash_rejects_edit_context() {
        let e = entry("Bash", "echo hi");
        let ctx = EventCtx::PreToolUse(PreToolUseCtx {
            tool_name: "Edit".into(),
            tool_input: String::new(),
        });
        assert!(!matcher_accepts(&e, &ctx));
    }
}
