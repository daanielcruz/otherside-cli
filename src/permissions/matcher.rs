

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
    let open = match src.find('(') {
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
    if !src.ends_with(')') {
        return Err(MatcherParseError::UnclosedParen(src.to_string()));
    }
    let tool = &src[..open];
    let pattern = &src[open + 1..src.len() - 1];
    if tool.is_empty() {
        return Err(MatcherParseError::EmptyTool(src.to_string()));
    }
    if pattern.is_empty() {
        return Err(MatcherParseError::EmptyPattern(src.to_string()));
    }
    Ok(MatcherRule {
        tool: MatcherTool::Named(tool.to_string()),
        pattern: Some(pattern.to_string()),
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
    } else {
        target.trim() == pattern.trim()
    }
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
    fn parse_unclosed_paren_errors() {
        let err = parse("Bash(git").unwrap_err();
        assert!(matches!(err, MatcherParseError::UnclosedParen(_)));
    }

    #[test]
    fn parse_empty_tool_errors() {
        let err = parse("(foo)").unwrap_err();
        assert!(matches!(err, MatcherParseError::EmptyTool(_)));
    }

    #[test]
    fn parse_empty_pattern_errors() {
        let err = parse("Bash()").unwrap_err();
        assert!(matches!(err, MatcherParseError::EmptyPattern(_)));
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
}
