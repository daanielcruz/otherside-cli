//! Slash-command dispatch. Some slashes run locally (wipe history,
//! exit, show inline help) and never reach the LLM; others are
//! passthrough prompts the model handles as normal text. The full
//! catalog — names, briefs, and dispatch classification — lives in
//! `slash_catalog`; this module is just the classifier front door.

use super::slash_catalog::{self, CATALOG, SlashKind};

/// What the event loop should do after the user presses Enter on a
/// `/slash-form` input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashAction {
    /// Wipe the conversation history and re-splash the mascot. Does
    /// NOT exit the TUI.
    Clear,
    /// Exit the TUI gracefully. Covers both `/exit` and `/bye`.
    Exit,
    /// Show the slash catalog inline in the streaming area as a
    /// `system`-role message.
    ShowHelp,
    /// `/model` with no argument — show the active model + 1M flag
    /// inline.
    ShowModel,
    /// `/model <id>` — switch the active model. The event loop
    /// validates the id shape and re-sizes the context window.
    SwitchModel(String),
    /// `/compact` — drop prior messages but push a short placeholder
    /// so the user can see the session continued (C46).
    Compact,
    /// `/status` — inline render of the statusline state.
    ShowStatus,
    /// `/context` — inline context-usage breakdown.
    ShowContext,
    /// `/config`, `/keybindings`, `/statusline` — pass the slash name
    /// so the event loop can emit the right hint text.
    ShowSettingsHint(String),
    /// `/login <provider>` — the loop emits instructions to exit + run
    /// `otherside login --provider <provider>` since auth flow needs
    /// stdin interaction outside the TUI.
    Login(String),
    /// `/logout <provider>` — ditto.
    Logout(String),
    /// Placeholder for slashes whose local handler hasn't landed yet;
    /// renders an inline system note so the user knows it's queued
    /// rather than silently no-op.
    NotYetWired(&'static str),
    /// Pass this raw text through to the LLM as a normal user prompt
    /// — the `/` prefix is part of the message.
    SendToLlm(String),
    /// Empty input or not a slash. Caller submits as-is.
    Passthrough,
}

/// Classify the input. Inputs that don't start with `/` fall through
/// to `Passthrough`.
pub fn classify(input: &str) -> SlashAction {
    let trimmed = input.trim_start();
    if !trimmed.starts_with('/') {
        return SlashAction::Passthrough;
    }
    let body = &trimmed[1..];
    let (name, rest) = split_name_and_args(body);

    if let Some(entry) = slash_catalog::lookup(name) {
        return match entry.kind {
            SlashKind::Local(action) => action.as_action(rest),
            SlashKind::Stubbed => SlashAction::NotYetWired(entry.name),
        };
    }

    // Unknown slash — pass through to the LLM so the user isn't
    // surprised by silent swallow. The model will typically echo
    // "I don't recognize that command".
    SlashAction::SendToLlm(input.to_string())
}

/// Split `/<name> <args>` body into (name, args). Name is the
/// contiguous run of non-whitespace after the slash.
fn split_name_and_args(body: &str) -> (&str, &str) {
    match body.find(char::is_whitespace) {
        Some(idx) => (&body[..idx], body[idx..].trim_start()),
        None => (body, ""),
    }
}

/// Static help catalog shown by `/help`. Walks `CATALOG` so every
/// entry surfaces — no separate list to drift.
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
    fn clear_is_local() {
        assert_eq!(classify("/clear"), SlashAction::Clear);
    }

    #[test]
    fn exit_and_bye_both_exit() {
        assert_eq!(classify("/exit"), SlashAction::Exit);
        assert_eq!(classify("/bye"), SlashAction::Exit);
    }

    #[test]
    fn help_shows_catalog() {
        assert_eq!(classify("/help"), SlashAction::ShowHelp);
    }

    #[test]
    fn stubbed_slash_returns_not_yet_wired() {
        match classify("/resume") {
            SlashAction::NotYetWired(name) => assert_eq!(name, "resume"),
            other => panic!("expected NotYetWired, got {other:?}"),
        }
    }

    #[test]
    fn compact_is_local() {
        assert_eq!(classify("/compact"), SlashAction::Compact);
    }

    #[test]
    fn model_without_args_shows_current() {
        assert_eq!(classify("/model"), SlashAction::ShowModel);
    }

    #[test]
    fn model_with_arg_switches() {
        match classify("/model claude-opus-4-7[1m]") {
            SlashAction::SwitchModel(id) => {
                assert_eq!(id, "claude-opus-4-7[1m]");
            }
            other => panic!("expected SwitchModel, got {other:?}"),
        }
    }

    #[test]
    fn status_and_context_are_local() {
        assert_eq!(classify("/status"), SlashAction::ShowStatus);
        assert_eq!(classify("/context"), SlashAction::ShowContext);
    }

    #[test]
    fn login_and_logout_carry_provider() {
        match classify("/login anthropic-oauth") {
            SlashAction::Login(p) => assert_eq!(p, "anthropic-oauth"),
            other => panic!("expected Login, got {other:?}"),
        }
        match classify("/logout") {
            SlashAction::Logout(p) => assert_eq!(p, ""),
            other => panic!("expected Logout, got {other:?}"),
        }
    }

    #[test]
    fn unknown_slash_sends_to_llm() {
        match classify("/this-is-not-a-slash") {
            SlashAction::SendToLlm(s) => assert_eq!(s, "/this-is-not-a-slash"),
            other => panic!("expected SendToLlm, got {other:?}"),
        }
    }

    #[test]
    fn slash_with_args_keeps_args() {
        // Args after the slash go to the LLM in passthrough mode.
        match classify("/this-slash-does-not-exist with some args") {
            SlashAction::SendToLlm(s) => {
                assert!(s.contains("with some args"));
            }
            other => panic!("expected SendToLlm, got {other:?}"),
        }
    }

    #[test]
    fn slash_case_insensitive() {
        assert_eq!(classify("/CLEAR"), SlashAction::Clear);
        assert_eq!(classify("/Help"), SlashAction::ShowHelp);
    }

    #[test]
    fn leading_whitespace_tolerated() {
        assert_eq!(classify("  /clear"), SlashAction::Clear);
    }

    #[test]
    fn help_includes_all_catalog_entries() {
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
    fn newly_added_slashes_route_to_a_local_action() {
        // After the catalog refactor, every named slash resolves to
        // *some* local or stubbed action — none should fall through
        // to SendToLlm as an "unknown" command.
        for name in ["config", "model", "effort", "plan", "permissions", "mcp",
                     "login", "logout", "init", "simplify", "verify",
                     "update-config", "statusline", "diff", "skills",
                     "agents", "context", "keybindings", "sandbox"] {
            let action = classify(&format!("/{name}"));
            let is_ok = matches!(
                action,
                SlashAction::NotYetWired(_)
                    | SlashAction::ShowModel
                    | SlashAction::SwitchModel(_)
                    | SlashAction::Compact
                    | SlashAction::ShowStatus
                    | SlashAction::ShowContext
                    | SlashAction::ShowSettingsHint(_)
                    | SlashAction::Login(_)
                    | SlashAction::Logout(_)
            );
            assert!(
                is_ok,
                "/{name} must resolve to a recognized action, got {action:?}"
            );
        }
    }
}
