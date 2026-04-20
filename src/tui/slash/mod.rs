//! Slash command dispatcher.
//!
//! Entry point for slash-prefix input handling. The module is organized
//! as the canonical 6 categories from `docs/slashes.md`, one file per
//! category:
//!
//! - [`catalog`] — single source of truth for names, briefs, kinds.
//! - [`instant`] — silent immediate side-effect (`/clear`, `/exit`, `/bye`).
//! - [`toggle`] — state flip + ephemeral confirmation (`/plan`, `/copy`…).
//! - [`skill`] — bundled SKILL.md body → user turn (`/dream`, `/statusline`…).
//! - [`anchor`] — user echo + `⎿` system anchor (`/compact`, `/branch`…).
//! - [`panel`] — modal overlay picker (`/model`, `/effort`, `/help`…).
//! - [`auth`] — provider login/logout dispatch (`/login`, `/logout`).
//!
//! `classify(input)` maps raw input into a [`SlashAction`]; the event
//! loop routes each variant to its per-category handler. Unknown slashes
//! and non-slash input converge on `Passthrough`, which the caller submits
//! as a user turn.

pub mod anchor;
pub mod auth;
pub mod catalog;
pub mod instant;
pub mod panel;
pub mod skill;
pub mod toggle;

pub use catalog::{PanelKind, SlashEntry, SlashKind, CATALOG};

/// What the event loop should do after the user presses Enter with a
/// slash-prefixed input. Seven variants: six categories + `Passthrough`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashAction {
    /// `instant` category — silent immediate side-effect. Handler may
    /// signal app-wide exit via its return value.
    Instant { name: String, args: String },
    /// `toggle` category — state flip, ephemeral feedback row.
    Toggle { name: String, args: String },
    /// `skill` category — bundled SKILL.md body emitted as a user turn.
    Skill { name: String, args: String },
    /// `anchor` category — user echo + dim `⎿` anchor line.
    Anchor { name: String, args: String },
    /// `panel` category — mount an overlay picker (discriminator picks
    /// which picker).
    Panel(PanelKind),
    /// `auth` category — provider login/logout dispatch.
    Auth { name: String, args: String },
    /// Empty input, non-slash input, or unknown slash. Caller submits
    /// the original text verbatim (non-slash) or as a user turn (unknown
    /// slash). Upstream's `type: 'prompt'` fallback shape.
    Passthrough,
}

/// Signal returned by per-category handlers. The event loop observes
/// these to route second-order effects — exit the TUI, submit a user
/// turn to the LLM, or nothing (handler already mutated state).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashOutcome {
    /// Handler mutated state; event loop has nothing more to do.
    Handled,
    /// Event loop should break out — TUI termination.
    ExitApp,
    /// Handler produced a user turn body; event loop should submit it
    /// to the provider.
    SendTurn(String),
}

/// Classify the input. Inputs that don't start with `/` fall through
/// to `Passthrough`. Unknown slashes also return `Passthrough` so the
/// caller submits them as a user turn (preserves upstream's "echo
/// unknown slash at the model" behavior).
pub fn classify(input: &str) -> SlashAction {
    let trimmed = input.trim_start();
    if !trimmed.starts_with('/') {
        return SlashAction::Passthrough;
    }
    // Double-slash input is NOT a slash — treat it as a literal user
    // turn. Observed during tmux parity: after Esc on autocomplete the
    // leading `/` lingered in the buffer and a subsequent `/permissions`
    // produced `//permissions`, escaping the dispatcher.
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
    SlashAction::Passthrough
}

/// Split `/<name> <args>` body into (name, args). Name is the contiguous
/// run of non-whitespace after the slash; args is the remainder, trimmed
/// of leading whitespace.
fn split_name_and_args(body: &str) -> (&str, &str) {
    match body.find(char::is_whitespace) {
        Some(idx) => (&body[..idx], body[idx..].trim_start()),
        None => (body, ""),
    }
}

/// Static help catalog shown by `/help`. Walks `CATALOG` so every entry
/// surfaces — no separate list to drift.
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
    fn bye_is_instant() {
        match classify("/bye") {
            SlashAction::Instant { name, .. } => assert_eq!(name, "bye"),
            other => panic!("expected Instant, got {other:?}"),
        }
    }

    #[test]
    fn exit_is_instant_no_confirmation() {
        // docs/slashes.md promotes /exit to instant; no more confirm overlay.
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
    fn help_is_panel() {
        assert_eq!(classify("/help"), SlashAction::Panel(PanelKind::Help));
    }

    #[test]
    fn model_routes_to_panel() {
        assert_eq!(classify("/model"), SlashAction::Panel(PanelKind::Model));
        // Args do NOT flip the routing.
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
    fn statusline_is_skill() {
        match classify("/statusline") {
            SlashAction::Skill { name, .. } => assert_eq!(name, "statusline"),
            other => panic!("expected Skill, got {other:?}"),
        }
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
    fn unknown_slash_is_passthrough() {
        assert_eq!(
            classify("/this-is-not-a-slash"),
            SlashAction::Passthrough
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
