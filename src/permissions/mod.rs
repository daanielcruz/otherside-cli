pub mod matcher;
pub mod prompt;

pub use matcher::{MatcherParseError, MatcherRule, MatcherTool};
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
        let mut w = self
            .0
            .write()
            .expect("RuntimePermissionGrants lock poisoned");
        if !w.contains(&rule) {
            w.push(rule);
        }
    }

    pub fn snapshot(&self) -> Vec<String> {
        let r = self
            .0
            .read()
            .expect("RuntimePermissionGrants lock poisoned");
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

    let empty = PermissionsConfig::default();
    let perms = settings.permissions.as_ref().unwrap_or(&empty);

    if effective_mode == PermissionMode::Plan && is_mutating(tool) {
        return Decision::Deny {
            rule: "plan-mode blocks mutating tools".into(),
        };
    }

    if let Some(rule) = best_match(tool, tool_input, &perms.deny) {
        return Decision::Deny { rule };
    }

    if matches!(tool, "Edit" | "Write" | "NotebookEdit") && is_dangerous_edit_path(tool_input) {
        return match effective_mode {
            PermissionMode::DontAsk => Decision::Deny {
                rule: "dontAsk blocks edits to protected paths".into(),
            },
            _ => Decision::Ask { rule: None },
        };
    }

    if let Some(rule) = best_match(tool, tool_input, &perms.ask) {
        return match effective_mode {
            PermissionMode::DontAsk => Decision::Deny { rule },
            _ => Decision::Ask { rule: Some(rule) },
        };
    }

    if effective_mode == PermissionMode::Yolo {
        return Decision::Allow;
    }

    if let Some(rule) = best_match(tool, tool_input, &perms.allow) {
        let _ = rule;
        return Decision::Allow;
    }

    if effective_mode == PermissionMode::Plan {
        return Decision::Allow;
    }

    if effective_mode == PermissionMode::AcceptEdits
        && matches!(tool, "Edit" | "Write" | "NotebookEdit")
    {
        if edit_path_within_allowed_roots(tool_input, perms) {
            return Decision::Allow;
        }
        return Decision::Ask { rule: None };
    }

    if !is_mutating(tool) {
        return Decision::Allow;
    }

    if effective_mode == PermissionMode::DontAsk {
        return Decision::Deny {
            rule: "dontAsk blocks unapproved mutating tools".into(),
        };
    }

    Decision::Ask { rule: None }
}

fn is_mutating(tool: &str) -> bool {
    MUTATING_TOOLS.contains(&tool)
}

const DANGEROUS_DIRECTORIES: &[&str] = &[".git", ".vscode", ".idea", ".claude", ".otherside"];

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

fn extract_path(tool_input: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(tool_input) {
        Ok(val) => val
            .get("file_path")
            .or_else(|| val.get("notebook_path"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Err(_) => tool_input.to_string(),
    }
}

fn edit_path_within_allowed_roots(tool_input: &str, perms: &PermissionsConfig) -> bool {
    let raw = extract_path(tool_input);
    if raw.is_empty() {
        return true;
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let canon = std::path::PathBuf::from(&raw);
    let absolute = if canon.is_absolute() {
        canon
    } else {
        cwd.join(&canon)
    };
    let normalized = normalize_path(&absolute);

    let mut roots: Vec<std::path::PathBuf> =
        Vec::with_capacity(perms.additional_directories.len() + 1);
    roots.push(normalize_path(&cwd));
    for extra in &perms.additional_directories {
        let p = std::path::PathBuf::from(extra);
        let abs = if p.is_absolute() { p } else { cwd.join(p) };
        roots.push(normalize_path(&abs));
    }
    roots.iter().any(|root| normalized.starts_with(root))
}

fn normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for comp in path.components() {
        use std::path::Component;
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_dangerous_edit_path(tool_input: &str) -> bool {
    let path = match serde_json::from_str::<serde_json::Value>(tool_input) {
        Ok(val) => val
            .get("file_path")
            .or_else(|| val.get("notebook_path"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Err(_) => tool_input.to_string(),
    };
    if path.is_empty() {
        return false;
    }

    if has_suspicious_windows_path_pattern(&path) {
        return true;
    }

    let lower = path.to_lowercase();
    for seg in lower.split(&['/', '\\'][..]) {
        let normalized = seg.trim_end_matches(['.', ' ']);
        if DANGEROUS_DIRECTORIES
            .iter()
            .any(|d| normalized == d.to_lowercase())
        {
            return true;
        }
    }

    let basename = lower
        .rsplit(&['/', '\\'][..])
        .next()
        .unwrap_or(lower.as_str())
        .trim_end_matches(['.', ' ']);
    if DANGEROUS_FILES.iter().any(|f| basename == f.to_lowercase()) {
        return true;
    }

    if path.starts_with("\\\\") || path.starts_with("//") {
        return true;
    }

    false
}

fn has_suspicious_windows_path_pattern(path: &str) -> bool {
    if path.starts_with("\\\\?\\")
        || path.starts_with("\\\\.\\")
        || path.starts_with("//?/")
        || path.starts_with("//./")
    {
        return true;
    }
    if path.contains("~1")
        || path.contains("~2")
        || path.contains("~3")
        || path.contains("~4")
        || path.contains("~5")
        || path.contains("~6")
        || path.contains("~7")
        || path.contains("~8")
        || path.contains("~9")
    {
        return true;
    }
    if path.ends_with('.') || path.ends_with(' ') {
        return true;
    }
    let upper = path.to_ascii_uppercase();
    if [".CON", ".PRN", ".AUX", ".NUL"]
        .iter()
        .any(|suffix| upper.ends_with(suffix))
        || (1..=9).any(|n| upper.ends_with(&format!(".COM{n}")))
        || (1..=9).any(|n| upper.ends_with(&format!(".LPT{n}")))
    {
        return true;
    }
    path.split(&['/', '\\'][..])
        .any(|segment| segment.len() >= 3 && segment.chars().all(|ch| ch == '.'))
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
    fn yolo_respects_deny_rules() {
        let s = settings_with(&[], &["Bash(rm:*)"], &[]);
        let d = resolve("Bash", "rm -rf /", &s, PermissionMode::Yolo);
        assert!(matches!(d, Decision::Deny { .. }));
    }

    #[test]
    fn yolo_allows_without_matching_deny_or_ask() {
        let s = settings_with(&[], &["Bash(rm:*)"], &[]);
        let d = resolve("Bash", "ls -la", &s, PermissionMode::Yolo);
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
        assert_eq!(
            resolve("Read", "", &s, PermissionMode::Plan),
            Decision::Allow
        );
        assert_eq!(
            resolve("Grep", "", &s, PermissionMode::Plan),
            Decision::Allow
        );
    }

    #[test]
    fn plan_read_tools_still_respect_deny_rules() {
        let s = settings_with(&[], &["Read"], &[]);
        let d = resolve("Read", "/repo/secret.txt", &s, PermissionMode::Plan);
        assert!(matches!(d, Decision::Deny { .. }));
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
    fn ask_beats_allow() {
        let s = settings_with(&["Bash(git *)"], &[], &["Bash(git push*)"]);
        let d = resolve("Bash", "git push origin main", &s, PermissionMode::Default);
        assert_eq!(
            d,
            Decision::Ask {
                rule: Some("Bash(git push*)".into())
            }
        );
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
    fn dont_ask_denies_unapproved_mutating_tools() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve("Bash", "ls", &s, PermissionMode::DontAsk);
        assert!(matches!(d, Decision::Deny { .. }));
    }

    #[test]
    fn dont_ask_allows_preapproved_tools() {
        let s = settings_with(&["Bash(ls:*)"], &[], &[]);
        let d = resolve("Bash", "ls -la", &s, PermissionMode::DontAsk);
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn yolo_respects_ask_rules() {
        let s = settings_with(&[], &[], &["Bash(git push*)"]);
        let d = resolve("Bash", "git push", &s, PermissionMode::Yolo);
        assert!(matches!(d, Decision::Ask { .. }));
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
            "/home/user/.claude.json",
        ] {
            let input = format!(r#"{{"file_path":"{path}"}}"#);
            let d = resolve("Edit", &input, &s, PermissionMode::AcceptEdits);
            assert_eq!(
                d,
                Decision::Ask { rule: None },
                "path {path} slipped through"
            );
        }
    }

    #[test]
    fn accept_edits_refuses_claude_config_dir() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Write",
            r#"{"file_path":"/home/user/.claude/settings.json","content":"{}"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_refuses_otherside_config_dir() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Write",
            r#"{"file_path":"/home/user/.otherside/settings.json","content":"{}"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_refuses_otherside_case_insensitive() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Edit",
            r#"{"file_path":"/proj/.OtherSide/credentials.json"}"#,
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
    fn safety_checks_apply_to_raw_matcher_path_and_yolo() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve("Write", "/repo/.git/config", &s, PermissionMode::Yolo);
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_refuses_suspicious_windows_path_patterns() {
        let s = settings_with(&[], &[], &[]);
        for path in [
            r"\\?\C:\repo\file.txt",
            "/repo/.git./config",
            "/repo/GIT~1/config",
            "/repo/settings.json.CON",
            "/repo/.../file.txt",
        ] {
            let d = resolve("Edit", path, &s, PermissionMode::AcceptEdits);
            assert_eq!(
                d,
                Decision::Ask { rule: None },
                "path {path} slipped through"
            );
        }
    }

    fn settings_with_extra_dirs(allow: &[&str], deny: &[&str], ask: &[&str], extra: &[&str]) -> Settings {
        let mut s = Settings::default();
        s.permissions = Some(PermissionsConfig {
            allow: allow.iter().map(|r| parse_rule(r)).collect(),
            deny: deny.iter().map(|r| parse_rule(r)).collect(),
            ask: ask.iter().map(|r| parse_rule(r)).collect(),
            additional_directories: extra.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        });
        s
    }

    #[test]
    fn accept_edits_allows_safe_project_path() {
        let s = settings_with_extra_dirs(&[], &[], &[], &["/proj"]);
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
        let s = settings_with_extra_dirs(&[], &[], &[], &["/proj"]);
        let d = resolve(
            "NotebookEdit",
            r#"{"notebook_path":"/proj/book.ipynb","cell_id":"a","new_source":"x"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn accept_edits_blocks_write_outside_cwd_and_additional_dirs() {
        let s = settings_with(&[], &[], &[]);
        let d = resolve(
            "Write",
            r#"{"file_path":"/etc/some.conf","content":"x"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_blocks_traversal_escape() {
        let s = settings_with_extra_dirs(&[], &[], &[], &["/proj"]);
        let d = resolve(
            "Edit",
            r#"{"file_path":"/proj/../etc/passwd"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Ask { rule: None });
    }

    #[test]
    fn accept_edits_honors_additional_directories_listing() {
        let s = settings_with_extra_dirs(&[], &[], &[], &["/opt/workspace"]);
        let d = resolve(
            "Edit",
            r#"{"file_path":"/opt/workspace/file.txt"}"#,
            &s,
            PermissionMode::AcceptEdits,
        );
        assert_eq!(d, Decision::Allow);
    }
}
