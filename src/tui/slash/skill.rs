//! Skill handler — bundled SKILL.md body becomes a user turn.
//!
//! Each `skills/<name>/SKILL.md` is embedded at compile time via
//! `include_str!`. The handler resolves the body by slash name and
//! emits a user turn of the shape `<skill_body>\n\n<args>` so the LLM
//! treats the skill instructions as its active task.
//!
//! When a skill name is not in the bundled table the handler falls
//! back to the raw `/<name> <args>` string — this keeps `Passthrough`
//! -adjacent behavior for slashes that were added to the catalog
//! without a bundled body yet (e.g. `/loop` after openspec 011 moved
//! it here; upstream body depends on `ScheduleCronTool` which otherside
//! has not ported).

use super::super::state::ConversationState;
use super::SlashOutcome;

/// Lookup table of bundled skill bodies. Each entry is a slash name →
/// verbatim SKILL.md contents (frontmatter + body). New entries land
/// here whenever a Skill-category row is added to
/// `docs/slashes.md` + `slash/catalog.rs`.
const SKILL_BODIES: &[(&str, &str)] = &[
    ("dream", include_str!("../../../skills/dream/SKILL.md")),
    ("statusline", include_str!("../../../skills/statusline/SKILL.md")),
    ("init", include_str!("../../../skills/init/SKILL.md")),
    (
        "init-verifiers",
        include_str!("../../../skills/init-verifiers/SKILL.md"),
    ),
    ("review", include_str!("../../../skills/review/SKILL.md")),
    (
        "security-review",
        include_str!("../../../skills/security-review/SKILL.md"),
    ),
];

/// Resolve a skill body by slash name. Returns `None` when the name
/// has no bundled body — the caller falls back to a raw slash pass.
pub fn lookup_body(name: &str) -> Option<&'static str> {
    SKILL_BODIES
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, body)| *body)
}

/// Dispatch a Skill-category slash. Returns `SendTurn(<body>\n\n<args>)`
/// so the event loop submits the skill as a user turn. When no body
/// is bundled, fall back to `/<name> <args>` verbatim.
pub fn handle(name: &str, args: &str, _state: &mut ConversationState) -> SlashOutcome {
    let body = lookup_body(name);
    let user_turn = match (body, args.is_empty()) {
        (Some(body), true) => body.to_string(),
        (Some(body), false) => format!("{body}\n\n{args}"),
        (None, true) => format!("/{name}"),
        (None, false) => format!("/{name} {args}"),
    };
    SlashOutcome::SendTurn(user_turn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_skill_slash_has_body() {
        // The 6 Skill-category rows that ship a SKILL.md via
        // include_str! — missing entries would fail the build. This
        // asserts the runtime lookup table is populated. `/loop`
        // lives in the catalog but has no bundled body yet (upstream
        // body depends on ScheduleCronTool parity — future change).
        let expected = [
            "dream",
            "statusline",
            "init",
            "init-verifiers",
            "review",
            "security-review",
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
        assert!(lookup_body("Security-Review").is_some());
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
    fn handle_known_skill_appends_args_after_body() {
        let mut st = ConversationState::default();
        let outcome = handle("review", "#42", &mut st);
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
        // openspec 011 reclassified /loop Anchor → Skill (upstream
        // `registerBundledSkill({ name: 'loop' })`). No bundled body
        // yet — handler emits the raw slash form so the provider
        // sees the user's intent even if the skill body never lands.
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
