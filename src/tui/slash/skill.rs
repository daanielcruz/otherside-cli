

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
    let is_dream = name.eq_ignore_ascii_case("dream");
    let user_turn = match (body, args.is_empty()) {
        (Some(body), true) => body,
        (Some(body), false) if is_dream => {
            format!("{body}\n\n## Additional context\n\n{args}")
        }
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
    let home = base.home_dir().to_string_lossy().into_owned();
    let mut result = body.replace("~/.otherside", &format!("{home}/.otherside"));
    if result.contains("{{MEMORY_ROOT}}")
        || result.contains("{{TRANSCRIPT_DIR}}")
        || result.contains("{{TEAM_GUIDANCE}}")
    {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| home.clone());
        let memory_root_slash = crate::harness::session_env::resolve_memory_dir(&cwd);
        let memory_root = memory_root_slash.trim_end_matches('/').to_string();
        let transcript_dir = memory_root
            .strip_suffix("/memory")
            .unwrap_or(&memory_root)
            .to_string();
        let team_dir = format!("{memory_root}/team");
        let team_block = if std::path::Path::new(&team_dir).is_dir() {
            format!("\n{TEAM_MEMORY_GUIDANCE}\n")
        } else {
            String::new()
        };
        result = result
            .replace("{{MEMORY_ROOT}}", &memory_root)
            .replace("{{TRANSCRIPT_DIR}}", &transcript_dir)
            .replace("{{TEAM_GUIDANCE}}", &team_block);
    }
    result
}

const TEAM_MEMORY_GUIDANCE: &str = "## Team memory (`team/` subdirectory)\n\nThe `team/` subdirectory holds memories shared across everyone working in this repo. Other teammates' Claude sessions write here too — treat it differently from your personal files:\n\n- **Phase 1:** `ls team/` and skim it alongside your personal files. A teammate may have already captured something you'd otherwise duplicate.\n- **Phase 3:** Merge near-duplicates *within* `team/` the same way you would personal memories. If a personal memory restates a team memory, delete the personal one.\n- **Phase 4 — be conservative pruning `team/`:**\n  - DO delete or fix a team memory that is clearly contradicted by the current code, or that a newer team memory marks as superseded.\n  - DO NOT delete a team memory just because you don't recognize it or it isn't relevant to *your* recent sessions — a teammate may rely on it.\n  - When unsure, leave it. A stale team memory costs little; deleting a teammate's load-bearing note costs a lot.\n\nDo not promote personal memories into `team/` during a dream — that's a deliberate choice the user makes via `/remember`, not something to do reflexively.";

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
    fn dream_args_wrap_in_additional_context_section() {
        let mut st = ConversationState::default();
        let outcome = handle("dream", "nightly", &mut st);
        match outcome {
            SlashOutcome::SendTurn(body) => {
                assert!(body.contains("## Additional context\n\nnightly"));
            }
            other => panic!("expected SendTurn, got {other:?}"),
        }
    }

    #[test]
    fn dream_body_resolves_memory_and_transcript_placeholders() {
        let mut st = ConversationState::default();
        let outcome = handle("dream", "", &mut st);
        match outcome {
            SlashOutcome::SendTurn(body) => {
                assert!(!body.contains("{{MEMORY_ROOT}}"));
                assert!(!body.contains("{{TRANSCRIPT_DIR}}"));
                assert!(!body.contains("{{TEAM_GUIDANCE}}"));
                assert!(body.contains("Phase 1 — Orient"));
                assert!(body.contains("Phase 4 — Prune"));
                assert!(body.contains("`MEMORY.md`"));
                assert!(body.contains(
                    "This directory already exists — write to it directly with the Write tool"
                ));
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
