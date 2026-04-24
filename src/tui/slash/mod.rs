

pub mod agents_panel;
pub mod anchor;
pub mod auth;
pub mod catalog;
pub mod instant;
pub mod panel;
pub mod skill;
pub mod tasks_panel;
pub mod toggle;

pub use catalog::{PanelKind, SlashEntry, SlashKind, CATALOG};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashAction {

    Instant { name: String, args: String },

    Toggle { name: String, args: String },

    Skill { name: String, args: String },

    Anchor { name: String, args: String },

    Panel(PanelKind),

    Auth { name: String, args: String },

    Unknown { name: String, args: String },

    Passthrough,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashOutcome {

    Handled,

    ExitApp,

    SendTurn(String),
}

pub fn classify(input: &str) -> SlashAction {
    let trimmed = input.trim_start();
    if !trimmed.starts_with('/') {
        return SlashAction::Passthrough;
    }

    if trimmed.starts_with("//") {
        return SlashAction::Passthrough;
    }
    let body = &trimmed[1..];
    let (name, rest) = split_name_and_args(body);

    if let Some(entry) = catalog::lookup(name) {
        return match entry.kind {
            SlashKind::Instant => SlashAction::Instant {
                name: name.to_string(),
                args: rest.to_string(),
            },
            SlashKind::Toggle => SlashAction::Toggle {
                name: name.to_string(),
                args: rest.to_string(),
            },
            SlashKind::Skill => SlashAction::Skill {
                name: name.to_string(),
                args: rest.to_string(),
            },
            SlashKind::Anchor => SlashAction::Anchor {
                name: name.to_string(),
                args: rest.to_string(),
            },
            SlashKind::Panel(pk) => SlashAction::Panel(pk),
            SlashKind::Auth => SlashAction::Auth {
                name: name.to_string(),
                args: rest.to_string(),
            },
        };
    }

    if name.is_empty() {
        return SlashAction::Passthrough;
    }

    if !looks_like_command(name) {
        return SlashAction::Passthrough;
    }

    SlashAction::Unknown {
        name: name.to_string(),
        args: rest.to_string(),
    }
}

fn looks_like_command(name: &str) -> bool {
    !name
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == ':' || c == '-' || c == '_'))
}

fn split_name_and_args(body: &str) -> (&str, &str) {
    match body.find(char::is_whitespace) {
        Some(idx) => (&body[..idx], body[idx..].trim_start()),
        None => (body, ""),
    }
}

pub fn help_text() -> String {
    let mut out = String::from("slash commands\n");
    let mut max_name = 0usize;
    for e in CATALOG {
        max_name = max_name.max(e.name.chars().count() + 1);
    }
    for e in CATALOG {
        let slash_form = format!("/{}", e.name);
        let pad = max_name.saturating_sub(slash_form.chars().count());
        out.push_str(&format!(
            "  {}{}  — {}\n",
            slash_form,
            " ".repeat(pad),
            e.brief
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_slash_input_passes_through() {
        assert!(matches!(classify("hello"), SlashAction::Passthrough));
        assert!(matches!(classify(""), SlashAction::Passthrough));
    }

    #[test]
    fn clear_is_instant() {
        match classify("/clear") {
            SlashAction::Instant { name, .. } => assert_eq!(name, "clear"),
            other => panic!("expected Instant, got {other:?}"),
        }
    }

    #[test]
    fn bye_reclassified_as_unknown() {

        assert_eq!(
            classify("/bye"),
            SlashAction::Unknown {
                name: "bye".to_string(),
                args: String::new(),
            }
        );
    }

    #[test]
    fn swarm_reclassified_as_unknown() {

        assert_eq!(
            classify("/swarm"),
            SlashAction::Unknown {
                name: "swarm".to_string(),
                args: String::new(),
            }
        );
    }

    #[test]
    fn exit_is_instant_no_confirmation() {

        match classify("/exit") {
            SlashAction::Instant { name, .. } => assert_eq!(name, "exit"),
            other => panic!("expected Instant, got {other:?}"),
        }
    }

    #[test]
    fn compact_is_anchor() {
        match classify("/compact trim") {
            SlashAction::Anchor { name, args } => {
                assert_eq!(name, "compact");
                assert_eq!(args, "trim");
            }
            other => panic!("expected Anchor, got {other:?}"),
        }
    }

    #[test]
    fn loop_is_skill_after_011_reclass() {

        match classify("/loop 5m /check-prs") {
            SlashAction::Skill { name, args } => {
                assert_eq!(name, "loop");
                assert_eq!(args, "5m /check-prs");
            }
            other => panic!("expected Skill, got {other:?}"),
        }
    }

    #[test]
    fn help_is_panel() {
        assert_eq!(classify("/help"), SlashAction::Panel(PanelKind::Help));
    }

    #[test]
    fn model_routes_to_panel() {
        assert_eq!(classify("/model"), SlashAction::Panel(PanelKind::Model));

        assert_eq!(
            classify("/model claude-opus-4-7[1m]"),
            SlashAction::Panel(PanelKind::Model)
        );
    }

    #[test]
    fn permissions_routes_to_panel() {
        assert_eq!(
            classify("/permissions"),
            SlashAction::Panel(PanelKind::Permissions)
        );
    }

    #[test]
    fn statusline_reclassified_as_unknown() {
        assert_eq!(
            classify("/statusline"),
            SlashAction::Unknown {
                name: "statusline".to_string(),
                args: String::new(),
            }
        );
    }

    #[test]
    fn login_is_auth() {
        match classify("/login anthropic") {
            SlashAction::Auth { name, args } => {
                assert_eq!(name, "login");
                assert_eq!(args, "anthropic");
            }
            other => panic!("expected Auth, got {other:?}"),
        }
    }

    #[test]
    fn plan_is_toggle() {
        match classify("/plan") {
            SlashAction::Toggle { name, .. } => assert_eq!(name, "plan"),
            other => panic!("expected Toggle, got {other:?}"),
        }
    }

    #[test]
    fn unknown_slash_classified_as_unknown() {
        assert_eq!(
            classify("/this-is-not-a-slash"),
            SlashAction::Unknown {
                name: "this-is-not-a-slash".to_string(),
                args: String::new(),
            }
        );
    }

    #[test]
    fn double_slash_is_passthrough() {
        assert_eq!(classify("//permissions"), SlashAction::Passthrough);
        assert_eq!(classify("//help"), SlashAction::Passthrough);
        assert_eq!(classify("  //clear"), SlashAction::Passthrough);
    }

    #[test]
    fn slash_case_insensitive() {
        match classify("/CLEAR") {
            SlashAction::Instant { name, .. } => assert_eq!(name, "CLEAR"),
            other => panic!("expected Instant, got {other:?}"),
        }
        assert_eq!(classify("/Help"), SlashAction::Panel(PanelKind::Help));
    }

    #[test]
    fn leading_whitespace_tolerated() {
        match classify("  /clear") {
            SlashAction::Instant { .. } => {}
            other => panic!("expected Instant, got {other:?}"),
        }
    }

    #[test]
    fn help_text_includes_all_catalog_entries() {
        let text = help_text();
        for entry in CATALOG {
            assert!(
                text.contains(&format!("/{}", entry.name)),
                "help text missing /{}",
                entry.name
            );
        }
    }

    #[test]
    fn no_catalog_row_returns_passthrough() {
        for entry in CATALOG {
            let action = classify(&format!("/{}", entry.name));
            assert!(
                !matches!(action, SlashAction::Passthrough),
                "/{} leaked to Passthrough: {action:?}",
                entry.name
            );
        }
    }
}
