#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatcherTool {
    Any,
    Named(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatcherRule {
    pub tool: MatcherTool,
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MatcherParseError {
    #[error("unclosed parenthesis in rule: {0:?}")]
    UnclosedParen(String),
    #[error("empty tool name in rule: {0:?}")]
    EmptyTool(String),
    #[error("empty pattern in rule: {0:?}")]
    EmptyPattern(String),
}

pub fn parse(src: &str) -> Result<MatcherRule, MatcherParseError> {
    let src = src.trim();
    if src == "*" {
        return Ok(MatcherRule {
            tool: MatcherTool::Any,
            pattern: None,
        });
    }
    let open = match find_first_unescaped(src, '(') {
        Some(i) => i,
        None => {
            if src.is_empty() {
                return Err(MatcherParseError::EmptyTool(src.to_string()));
            }
            return Ok(MatcherRule {
                tool: MatcherTool::Named(src.to_string()),
                pattern: None,
            });
        }
    };
    let close = match find_last_unescaped(src, ')') {
        Some(i) if i > open && i == src.len() - 1 => i,
        _ => {
            return Ok(MatcherRule {
                tool: MatcherTool::Named(src.to_string()),
                pattern: None,
            });
        }
    };
    let tool = &src[..open];
    let pattern = &src[open + 1..close];
    if tool.is_empty() {
        return Ok(MatcherRule {
            tool: MatcherTool::Named(src.to_string()),
            pattern: None,
        });
    }
    if pattern.is_empty() || pattern == "*" {
        return Ok(MatcherRule {
            tool: MatcherTool::Named(tool.to_string()),
            pattern: None,
        });
    }
    Ok(MatcherRule {
        tool: MatcherTool::Named(tool.to_string()),
        pattern: Some(unescape_rule_content(pattern)),
    })
}

impl MatcherRule {
    pub fn matches(&self, tool_name: &str, tool_input: &str) -> bool {
        let tool_ok = match &self.tool {
            MatcherTool::Any => true,
            MatcherTool::Named(n) => n == tool_name,
        };
        if !tool_ok {
            return false;
        }
        match self.pattern.as_deref() {
            None => true,
            Some(p) => prefix_matches(p, tool_input),
        }
    }
}

pub fn prefix_matches(pattern: &str, target: &str) -> bool {
    let pattern = pattern.trim();
    let target = target.trim();
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix(":*") {
        let prefix = prefix.trim();
        if target == prefix {
            return true;
        }
        if !target.starts_with(prefix) {
            return false;
        }
        match target.chars().nth(prefix.chars().count()) {
            None => true,
            Some(c) => !c.is_ascii_alphanumeric(),
        }
    } else if pattern.contains('*') || pattern.contains('?') {
        if let Some(rest) = pattern.strip_prefix("**/") {
            if wildcard_matches(rest, target) {
                return true;
            }
        }
        if let Some(prefix) = pattern.strip_suffix(" *") {
            if target == prefix {
                return true;
            }
            let full = format!("{prefix} ");
            if target.starts_with(&full) {
                return true;
            }
        }
        wildcard_matches(pattern, target)
    } else {
        target == pattern
    }
}

fn find_first_unescaped(src: &str, needle: char) -> Option<usize> {
    src.char_indices()
        .find(|(idx, ch)| *ch == needle && !is_escaped(src.as_bytes(), *idx))
        .map(|(idx, _)| idx)
}

fn find_last_unescaped(src: &str, needle: char) -> Option<usize> {
    src.char_indices()
        .rev()
        .find(|(idx, ch)| *ch == needle && !is_escaped(src.as_bytes(), *idx))
        .map(|(idx, _)| idx)
}

fn is_escaped(bytes: &[u8], idx: usize) -> bool {
    let mut count = 0;
    let mut i = idx;
    while i > 0 && bytes[i - 1] == b'\\' {
        count += 1;
        i -= 1;
    }
    count % 2 == 1
}

fn unescape_rule_content(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.peek().copied() {
                Some('(' | ')' | '\\') => {
                    out.push(chars.next().expect("peeked char exists"));
                }
                _ => out.push(ch),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn wildcard_matches(pattern: &str, target: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let target: Vec<char> = target.chars().collect();
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut match_after_star = 0usize;

    while t < target.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == target[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            p += 1;
            match_after_star = t;
        } else if let Some(star_idx) = star {
            p = star_idx + 1;
            match_after_star += 1;
            t = match_after_star;
        } else {
            return false;
        }
    }

    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_star_is_any() {
        let r = parse("*").unwrap();
        assert_eq!(r.tool, MatcherTool::Any);
        assert!(r.pattern.is_none());
    }

    #[test]
    fn parse_tool_with_pattern() {
        let r = parse("Bash(git status:*)").unwrap();
        assert_eq!(r.tool, MatcherTool::Named("Bash".into()));
        assert_eq!(r.pattern.as_deref(), Some("git status:*"));
    }

    #[test]
    fn parse_tool_without_parens_is_bare() {
        let r = parse("Read").unwrap();
        assert_eq!(r.tool, MatcherTool::Named("Read".into()));
        assert!(r.pattern.is_none());
    }

    #[test]
    fn parse_malformed_rule_as_non_matching_tool_name() {
        let r = parse("Bash(git").unwrap();
        assert_eq!(r.tool, MatcherTool::Named("Bash(git".into()));
        assert!(r.pattern.is_none());
    }

    #[test]
    fn parse_empty_tool_as_non_matching_tool_name() {
        let r = parse("(foo)").unwrap();
        assert_eq!(r.tool, MatcherTool::Named("(foo)".into()));
        assert!(r.pattern.is_none());
    }

    #[test]
    fn parse_empty_or_star_pattern_as_tool_wide() {
        let empty = parse("Bash()").unwrap();
        assert_eq!(empty.tool, MatcherTool::Named("Bash".into()));
        assert!(empty.pattern.is_none());

        let star = parse("Bash(*)").unwrap();
        assert_eq!(star.tool, MatcherTool::Named("Bash".into()));
        assert!(star.pattern.is_none());
    }

    #[test]
    fn parse_escaped_parentheses_in_pattern() {
        let r = parse(r#"Bash(python -c "print\(1\)")"#).unwrap();
        assert_eq!(r.tool, MatcherTool::Named("Bash".into()));
        assert_eq!(r.pattern.as_deref(), Some(r#"python -c "print(1)""#));
    }

    #[test]
    fn match_any_matches_every_tool() {
        let r = parse("*").unwrap();
        assert!(r.matches("Bash", "anything"));
        assert!(r.matches("Edit", "any-input"));
    }

    #[test]
    fn tool_mismatch_fails() {
        let r = parse("Bash(git:*)").unwrap();
        assert!(!r.matches("Edit", "git status"));
    }

    #[test]
    fn prefix_wildcard_matches_token_boundary() {
        let r = parse("Bash(git status:*)").unwrap();
        assert!(r.matches("Bash", "git status"));
        assert!(r.matches("Bash", "git status --short"));
        assert!(!r.matches("Bash", "git push"));
    }

    #[test]
    fn exact_pattern_requires_full_equality() {
        let r = parse("Bash(ls)").unwrap();
        assert!(r.matches("Bash", "ls"));
        assert!(!r.matches("Bash", "ls -la"));
    }

    #[test]
    fn wildcard_matches_any_position() {
        let r = parse("Bash(git diff*)").unwrap();
        assert!(r.matches("Bash", "git diff --stat"));
        assert!(!r.matches("Bash", "git status"));
    }

    #[test]
    fn wildcard_file_pattern_matches_paths() {
        let r = parse("Write(**/credentials.json)").unwrap();
        assert!(r.matches("Write", "/repo/app/credentials.json"));
        assert!(!r.matches("Write", "/repo/app/config.json"));
    }

    #[test]
    fn double_star_slash_prefix_matches_bare_basename() {
        let r = parse("Write(**/credentials.json)").unwrap();
        assert!(r.matches("Write", "credentials.json"));
        assert!(r.matches("Write", "./credentials.json"));
        assert!(r.matches("Write", "/credentials.json"));
        assert!(r.matches("Write", "a/b/credentials.json"));
        assert!(!r.matches("Write", "credentials.txt"));
    }

    #[test]
    fn trailing_space_star_is_optional_like_upstream() {
        let r = parse("Bash(git *)").unwrap();
        assert!(r.matches("Bash", "git"));
        assert!(r.matches("Bash", "git status"));
        assert!(r.matches("Bash", "git push origin main"));
        assert!(!r.matches("Bash", "gitx"));
        assert!(!r.matches("Bash", "gitx status"));
    }
}
