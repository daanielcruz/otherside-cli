//! Permission engine — matcher DSL + resolver + prompt surface.
//!
//! Inputs:
//! - `tool_name` from the agent loop's dispatch decision
//! - `tool_input` — stringified JSON of the model's argument object
//! - `PermissionMode` from the effective settings / CLI flag
//! - `PermissionsConfig` (`allow` / `deny` / `ask` rule lists)
//!
//! Output: [`Decision::Allow`], [`Decision::Deny`], or
//! [`Decision::Ask`] with the matching rule surface. The agent loop
//! short-circuits Deny, fires an interactive prompt for Ask, and
//! dispatches on Allow.

pub mod matcher;
pub mod prompt;

pub use matcher::{MatcherRule, MatcherTool, MatcherParseError};
pub use prompt::{PromptChoice, AllowScope};

use crate::config::settings::{PermissionMode, PermissionRule, PermissionsConfig, Settings};

/// Outcome of a permission query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny { rule: String },
    Ask { rule: Option<String> },
}

/// Source list that produced a match — exposed on Deny so the user
/// knows which rule triggered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleScope {
    Allow,
    Deny,
    Ask,
    FallThrough,
    ModeDefault,
}

/// Mutating tools — blocked in `plan` mode, gated in `default`.
pub const MUTATING_TOOLS: &[&str] = &[
    "Edit",
    "Write",
    "Bash",
    "BashOutput",
    "KillBash",
    "NotebookEdit",
];

/// Resolve a decision for `(tool, input, mode, permissions)`. Pure
/// function — no I/O, no prompts. The caller is responsible for
/// actually invoking `prompt::render` on `Decision::Ask`.
pub fn resolve(
    tool: &str,
    tool_input: &str,
    settings: &Settings,
    mode: PermissionMode,
) -> Decision {
    // yolo — caller already verified this isn't blocked at a higher
    // tier; treat as carte blanche.
    if mode == PermissionMode::Yolo {
        return Decision::Allow;
    }

    // plan — block every mutating tool; read-only tools pass.
    if mode == PermissionMode::Plan {
        if is_mutating(tool) {
            return Decision::Deny {
                rule: "plan-mode blocks mutating tools".into(),
            };
        }
        return Decision::Allow;
    }

    let empty = PermissionsConfig::default();
    let perms = settings.permissions.as_ref().unwrap_or(&empty);
    // Explicit deny rules outrank everything else — even Yolo was
    // already short-circuited above, so here Default/AcceptEdits are
    // the live modes.
    if let Some(rule) = best_match(tool, tool_input, &perms.deny) {
        return Decision::Deny { rule };
    }
    // Explicit allow rule → allow regardless of mutating/non-mutating
    // classification. Matches upstream's `alwaysAllowRules` behavior.
    if let Some(rule) = best_match(tool, tool_input, &perms.allow) {
        let _ = rule;
        return Decision::Allow;
    }
    // acceptEdits: Edit/Write pre-approved without needing a rule,
    // mirroring upstream "accept edits on" mode.
    if mode == PermissionMode::AcceptEdits && matches!(tool, "Edit" | "Write") {
        return Decision::Allow;
    }
    // Non-mutating tools (Read/Glob/Grep/ToolSearch/Skill/Agent/
    // WebFetch/WebSearch/Task*) are allowed by default in every mode
    // that didn't already short-circuit. Upstream's tool objects
    // declare `canUseTool` as unconditional allow for read-only
    // surfaces; only mutating tools flow through the ask path. This
    // matches `services/tools/toolExecution.ts:608` behavior where
    // most tools never reach the interactive prompt dialog.
    if !is_mutating(tool) {
        return Decision::Allow;
    }
    // Explicit ask rule takes precedence over the generic fallthrough
    // so the user can point the resolver at a specific rule surface.
    if let Some(rule) = best_match(tool, tool_input, &perms.ask) {
        return Decision::Ask { rule: Some(rule) };
    }

    // Mutating tool, no matching rule, no AcceptEdits short-circuit →
    // user approval required. The interactive modal lives behind
    // spec 007; until it ships, `dispatch_gated` degrades Ask to
    // `PermissionDenied` with a modal-pending note.
    Decision::Ask { rule: None }
}

fn is_mutating(tool: &str) -> bool {
    MUTATING_TOOLS.contains(&tool)
}

fn rule_to_string(rule: &PermissionRule) -> Option<String> {
    let tool = rule.tool_name.as_deref()?;
    match rule.match_pattern.as_deref() {
        Some(pattern) if !pattern.is_empty() => Some(format!("{tool}({pattern})")),
        Some(_) => Some(tool.to_string()),
        None => Some(tool.to_string()),
    }
}

fn best_match(tool: &str, tool_input: &str, rules: &[PermissionRule]) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for r in rules {
        let raw = match rule_to_string(r) {
            Some(s) => s,
            None => continue,
        };
        let parsed = match matcher::parse(&raw) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !parsed.matches(tool, tool_input) {
            continue;
        }
        let len = parsed
            .pattern
            .as_deref()
            .map(|p| p.chars().count())
            .unwrap_or(1);
        if best.as_ref().map(|(l, _)| *l).unwrap_or(0) <= len {
            best = Some((len, raw));
        }
    }
    best.map(|(_, rule)| rule)
}

/// Convenience constructor used by the pure tests below.
pub fn allow_all() -> PermissionsConfig {
    PermissionsConfig::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::Settings;

    fn parse_rule(raw: &str) -> PermissionRule {
        if let Ok(parsed) = matcher::parse(raw) {
            let tool_name = match parsed.tool {
                MatcherTool::Any => "*".to_string(),
                MatcherTool::Named(n) => n,
            };
            return PermissionRule {
                tool_name: Some(tool_name),
                match_pattern: parsed.pattern,
                extra: Default::default(),
            };
        }
        PermissionRule::default()
    }

    fn settings_with(allow: &[&str], deny: &[&str], ask: &[&str]) -> Settings {
        let mut s = Settings::default();
        s.permissions = Some(PermissionsConfig {
            allow: allow.iter().map(|r| parse_rule(r)).collect(),
            deny: deny.iter().map(|r| parse_rule(r)).collect(),
            ask: ask.iter().map(|r| parse_rule(r)).collect(),
            ..Default::default()
        });
        s
    }

    #[test]
    fn yolo_short_circuits_allow() {
        let s = settings_with(&[], &["Bash(rm:*)"], &[]);
        let d = resolve("Bash", "rm -rf /", &s, PermissionMode::Yolo);
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn plan_blocks_edit() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve("Edit", "", &s, PermissionMode::Plan);
        assert!(matches!(d, Decision::Deny { .. }));
    }

    #[test]
    fn plan_allows_read_tools() {
        let s = settings_with(&[], &[], &[]);
        assert_eq!(resolve("Read", "", &s, PermissionMode::Plan), Decision::Allow);
        assert_eq!(resolve("Grep", "", &s, PermissionMode::Plan), Decision::Allow);
    }

    #[test]
    fn deny_beats_allow() {
        let s = settings_with(&["Bash(rm:*)"], &["Bash(rm:*)"], &[]);
        let d = resolve("Bash", "rm -rf /tmp", &s, PermissionMode::Default);
        assert!(matches!(d, Decision::Deny { .. }));
    }

    #[test]
    fn allow_matches_then_allows() {
        let s = settings_with(&["Bash(ls:*)"], &[], &[]);
        let d = resolve("Bash", "ls -la", &s, PermissionMode::Default);
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn fallthrough_asks() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve("Bash", "curl foo.com", &s, PermissionMode::Default);
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn ask_rule_surfaces() {
        let s = settings_with(&[], &[], &["Bash(curl:*)"]);
        let d = resolve("Bash", "curl foo.com", &s, PermissionMode::Default);
        assert_eq!(
            d,
            Decision::Ask {
                rule: Some("Bash(curl:*)".into())
            }
        );
    }

    #[test]
    fn accept_edits_mode_allows_edit_without_rule() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve("Edit", "", &s, PermissionMode::AcceptEdits);
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn accept_edits_mode_still_asks_bash() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve("Bash", "ls", &s, PermissionMode::AcceptEdits);
        assert_eq!(d, Decision::Ask { rule: None });
    }
}
