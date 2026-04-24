

use super::super::state::ConversationState;
use super::SlashOutcome;

const SKILL_BODIES: &[(&str, &str)] = &[
    ("dream", include_str!("../../../skills_corpus/dream/SKILL.md")),
    ("init", include_str!("../../../skills_corpus/init/SKILL.md")),
    ("pr-review", include_str!("../../../skills_corpus/pr-review/SKILL.md")),
    (
        "pr-security-review",
        include_str!("../../../skills_corpus/pr-security-review/SKILL.md"),
    ),
    (
        "deep-security-review",
        include_str!("../../../skills_corpus/deep-security-review/SKILL.md"),
    ),
];

pub fn lookup_body(name: &str) -> Option<&'static str> {
    SKILL_BODIES
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, body)| *body)
}

pub fn bundled_names() -> Vec<&'static str> {
    SKILL_BODIES.iter().map(|(n, _)| *n).collect()
}

pub fn handle(name: &str, args: &str, _state: &mut ConversationState) -> SlashOutcome {
    let body = lookup_body(name).map(substitute_host_paths);
    let user_turn = match (body, args.is_empty()) {
        (Some(body), true) => body,
        (Some(body), false) => format!("{body}\n\n{args}"),
        (None, true) => format!("/{name}"),
        (None, false) => format!("/{name} {args}"),
    };
    SlashOutcome::SendTurn(user_turn)
}

fn substitute_host_paths(body: &str) -> String {
    let Some(base) = directories::BaseDirs::new() else {
        return body.to_string();
    };
    let home = base.home_dir().to_string_lossy();
    body.replace("~/.otherside", &format!("{home}/.otherside"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_skill_slash_has_body() {

        let expected = [
            "dream",
            "init",
            "pr-review",
            "pr-security-review",
            "deep-security-review",
        ];
        for name in expected {
            let body = lookup_body(name).unwrap_or_else(|| panic!("/{name} missing body"));
            assert!(!body.is_empty(), "/{name} body empty");
            assert!(
                body.starts_with("---"),
                "/{name} body missing frontmatter"
            );
        }
    }

    #[test]
    fn lookup_is_case_insensitive() {
        assert!(lookup_body("DREAM").is_some());
        assert!(lookup_body("PR-Security-Review").is_some());
    }

    #[test]
    fn unknown_skill_resolves_to_none() {
        assert!(lookup_body("not-a-skill").is_none());
    }

    #[test]
    fn handle_known_skill_emits_send_turn_with_body() {
        let mut st = ConversationState::default();
        let outcome = handle("dream", "", &mut st);
        match outcome {
            SlashOutcome::SendTurn(body) => {
                assert!(body.starts_with("---"));
                assert!(body.contains("Reflective memory consolidation"));
            }
            other => panic!("expected SendTurn, got {other:?}"),
        }
    }

    #[test]
    fn handle_substitutes_tilde_paths_with_host_home() {
        let mut st = ConversationState::default();
        let outcome = handle("dream", "", &mut st);
        let body = match outcome {
            SlashOutcome::SendTurn(body) => body,
            other => panic!("expected SendTurn, got {other:?}"),
        };

        assert!(
            !body.contains("~/.otherside"),
            "skill body must not ship the literal `~/.otherside` to the LLM — it defaults to `/root/` on the model side. Got body:\n{body}"
        );
        let base = directories::BaseDirs::new().expect("host base dirs resolvable in test env");
        let home = base.home_dir().to_string_lossy();
        assert!(
            body.contains(&format!("{home}/.otherside")),
            "expected host-absolute `{home}/.otherside` in substituted body"
        );
    }

    #[test]
    fn handle_known_skill_appends_args_after_body() {
        let mut st = ConversationState::default();
        let outcome = handle("pr-review", "#42", &mut st);
        match outcome {
            SlashOutcome::SendTurn(body) => {
                assert!(body.contains("---"));
                assert!(body.trim_end().ends_with("#42"));
            }
            other => panic!("expected SendTurn, got {other:?}"),
        }
    }

    #[test]
    fn handle_unknown_skill_falls_back_to_raw_slash() {
        let mut st = ConversationState::default();
        let outcome = handle("not-a-skill", "arg", &mut st);
        match outcome {
            SlashOutcome::SendTurn(body) => {
                assert_eq!(body, "/not-a-skill arg");
            }
            other => panic!("expected SendTurn, got {other:?}"),
        }
    }

    #[test]
    fn loop_falls_back_to_raw_slash_pass_until_body_bundled() {

        let mut st = ConversationState::default();
        let outcome = handle("loop", "5m /check-prs", &mut st);
        match outcome {
            SlashOutcome::SendTurn(body) => {
                assert_eq!(body, "/loop 5m /check-prs");
            }
            other => panic!("expected SendTurn, got {other:?}"),
        }
    }
}
