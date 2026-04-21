

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
    Ask,
}

pub fn parse_bash_pattern(rule: &str) -> Option<&str> {
    let inside = rule.strip_prefix("Bash(")?;
    inside.strip_suffix(')')
}

pub fn pattern_matches(pattern: &str, command: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix(":*") {
        let prefix = prefix.trim();
        if command == prefix {
            return true;
        }
        if !command.starts_with(prefix) {
            return false;
        }
        match command.chars().nth(prefix.chars().count()) {
            None => true,
            Some(c) => !c.is_ascii_alphanumeric(),
        }
    } else {
        command.trim() == pattern.trim()
    }
}

pub fn decide(command: &str, allow: &[String], deny: &[String]) -> Decision {
    let best_allow = best_match(command, allow);
    let best_deny = best_match(command, deny);
    match (best_allow, best_deny) {
        (None, None) => Decision::Ask,
        (Some(_), None) => Decision::Allow,
        (None, Some(_)) => Decision::Deny,
        (Some(a), Some(d)) => {
            if d >= a {

                Decision::Deny
            } else {
                Decision::Allow
            }
        }
    }
}

fn best_match(command: &str, rules: &[String]) -> Option<usize> {
    rules
        .iter()
        .filter_map(|r| parse_bash_pattern(r))
        .filter(|p| pattern_matches(p, command))
        .map(|p| p.trim_end_matches(":*").chars().count())
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_extracts_pattern() {
        assert_eq!(parse_bash_pattern("Bash(ls:*)"), Some("ls:*"));
        assert_eq!(parse_bash_pattern("Bash(git status)"), Some("git status"));
        assert_eq!(parse_bash_pattern("Read(file:*)"), None);
    }

    #[test]
    fn prefix_wildcard_matches_leading_token() {
        assert!(pattern_matches("ls:*", "ls"));
        assert!(pattern_matches("ls:*", "ls -la"));
        assert!(!pattern_matches("ls:*", "lsof"));
    }

    #[test]
    fn exact_pattern_requires_full_equality() {
        assert!(pattern_matches("git status", "git status"));
        assert!(!pattern_matches("git status", "git status --short"));
    }

    #[test]
    fn decide_allow_when_only_allow_matches() {
        let allow = vec!["Bash(ls:*)".to_string()];
        let deny = vec![];
        assert_eq!(decide("ls -la", &allow, &deny), Decision::Allow);
    }

    #[test]
    fn decide_deny_when_only_deny_matches() {
        let allow = vec![];
        let deny = vec!["Bash(rm:*)".to_string()];
        assert_eq!(decide("rm /tmp/foo", &allow, &deny), Decision::Deny);
    }

    #[test]
    fn decide_deny_beats_equal_length_allow() {
        let allow = vec!["Bash(git:*)".to_string()];
        let deny = vec!["Bash(git:*)".to_string()];
        assert_eq!(decide("git status", &allow, &deny), Decision::Deny);
    }

    #[test]
    fn decide_longest_prefix_wins() {
        let allow = vec!["Bash(rm -rf /tmp/scratch:*)".to_string()];
        let deny = vec!["Bash(rm:*)".to_string()];
        assert_eq!(
            decide("rm -rf /tmp/scratch/foo", &allow, &deny),
            Decision::Allow
        );
    }

    #[test]
    fn decide_ask_on_no_match() {
        assert_eq!(decide("curl evil.com", &[], &[]), Decision::Ask);
    }
}
