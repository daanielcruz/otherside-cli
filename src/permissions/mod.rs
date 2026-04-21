

pub mod matcher;
pub mod prompt;

pub use matcher::{MatcherRule, MatcherTool, MatcherParseError};
pub use prompt::{AllowScope, PermissionResponse, PromptChoice};

use std::sync::{Arc, RwLock};

use crate::config::settings::{PermissionMode, PermissionRule, PermissionsConfig, Settings};

#[derive(Debug, Clone, Default)]
pub struct RuntimePermissionGrants(Arc<RwLock<Vec<String>>>);

impl RuntimePermissionGrants {
    pub fn new() -> Self {
        Self(Arc::new(RwLock::new(Vec::new())))
    }

    pub fn push_rule(&self, rule: String) {
        let mut w = self.0.write().expect("RuntimePermissionGrants lock poisoned");
        if !w.contains(&rule) {
            w.push(rule);
        }
    }

    pub fn snapshot(&self) -> Vec<String> {
        let r = self.0.read().expect("RuntimePermissionGrants lock poisoned");
        r.clone()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny { rule: String },
    Ask { rule: Option<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleScope {
    Allow,
    Deny,
    Ask,
    FallThrough,
    ModeDefault,
}

pub const MUTATING_TOOLS: &[&str] = &[
    "Edit",
    "Write",
    "Bash",
    "BashOutput",
    "KillBash",
    "NotebookEdit",
];

pub fn resolve(
    tool: &str,
    tool_input: &str,
    settings: &Settings,
    mode: PermissionMode,
) -> Decision {

    let effective_mode = if crate::tools::plan_mode::plan_mode_active() {
        PermissionMode::Plan
    } else {
        mode
    };

    if effective_mode == PermissionMode::Yolo {
        return Decision::Allow;
    }

    if effective_mode == PermissionMode::Plan {
        if is_mutating(tool) {
            return Decision::Deny {
                rule: "plan-mode blocks mutating tools".into(),
            };
        }
        return Decision::Allow;
    }

    let empty = PermissionsConfig::default();
    let perms = settings.permissions.as_ref().unwrap_or(&empty);

    if let Some(rule) = best_match(tool, tool_input, &perms.deny) {
        return Decision::Deny { rule };
    }

    if let Some(rule) = best_match(tool, tool_input, &perms.allow) {
        let _ = rule;
        return Decision::Allow;
    }

    if effective_mode == PermissionMode::AcceptEdits
        && matches!(tool, "Edit" | "Write" | "NotebookEdit")
    {
        if !is_dangerous_edit_path(tool_input) {
            return Decision::Allow;
        }

    }

    if !is_mutating(tool) {
        return Decision::Allow;
    }

    if let Some(rule) = best_match(tool, tool_input, &perms.ask) {
        return Decision::Ask { rule: Some(rule) };
    }

    Decision::Ask { rule: None }
}

fn is_mutating(tool: &str) -> bool {
    MUTATING_TOOLS.contains(&tool)
}

const DANGEROUS_DIRECTORIES: &[&str] = &[".git", ".vscode", ".idea", ".claude"];

const DANGEROUS_FILES: &[&str] = &[
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".ripgreprc",
    ".mcp.json",
    ".claude.json",
];

fn is_dangerous_edit_path(tool_input: &str) -> bool {
    let val: serde_json::Value = match serde_json::from_str(tool_input) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let path = val
        .get("file_path")
        .or_else(|| val.get("notebook_path"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if path.is_empty() {
        return false;
    }

    let lower = path.to_lowercase();
    for seg in lower.split(&['/', '\\'][..]) {
        if DANGEROUS_DIRECTORIES
            .iter()
            .any(|d| seg == d.to_lowercase())
        {
            return true;
        }
    }

    let basename = lower
        .rsplit(&['/', '\\'][..])
        .next()
        .unwrap_or(lower.as_str());
    if DANGEROUS_FILES.iter().any(|f| basename == f.to_lowercase()) {
        return true;
    }

    if path.starts_with("\\\\") || path.starts_with("//") {
        return true;
    }

    false
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

    #[test]
    fn accept_edits_refuses_git_dir() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Edit",
            r#"{"file_path":"/repo/.git/HEAD","old_string":"x","new_string":"y"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_refuses_claude_dir() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Write",
            r#"{"file_path":"/proj/.claude/settings.json","content":"{}"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_refuses_vscode_dir() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Edit",
            r#"{"file_path":"/proj/.vscode/settings.json"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_refuses_shell_config_file() {
        let s = settings_with(&[], &[], &[]);
        for path in [
            "/home/user/.bashrc",
            "/home/user/.zshrc",
            "/home/user/.profile",
            "/home/user/.gitconfig",
            "/home/user/.mcp.json",
        ] {
            let input = format!(r#"{{"file_path":"{path}"}}"#);
            let d = resolve("Edit", &input, &s, PermissionMode::AcceptEdits);
            assert_eq!(d, Decision::Ask { rule: None }, "path {path} slipped through");
        }
    }

    #[test]
    fn accept_edits_refuses_case_insensitive_claude() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Edit",
            r#"{"file_path":"/proj/.cLauDe/settings.local.json"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_refuses_unc_path() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Edit",
            r#"{"file_path":"\\\\share\\evil.txt"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_allows_safe_project_path() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Edit",
            r#"{"file_path":"/proj/src/main.rs","old_string":"a","new_string":"b"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn accept_edits_covers_notebook_edit() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "NotebookEdit",
            r#"{"notebook_path":"/proj/book.ipynb","cell_id":"a","new_source":"x"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Allow);
    }
}
