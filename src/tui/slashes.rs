//! Slash-command dispatch — the classifier front door.
//!
//! The full catalog (names, briefs, kinds) lives in `slash_catalog`; this
//! module maps each `SlashKind` into a concrete `SlashAction` the event
//! loop can dispatch. Three kinds map as follows:
//!
//! - `SlashKind::Local(action)` → the action's specific variant
//!   (immediate side-effect).
//! - `SlashKind::InteractiveMenu(kind)` → `SlashAction::MenuPending(kind)`
//!   — a temporary fallback shipped by 012a. The event loop renders a
//!   muted inline note identifying the pending slash; the overlay state
//!   machine + menu widgets land in 012b/012c.
//! - `SlashKind::AiRouted` → `SlashAction::SendToLlm(raw_input)` — the
//!   slash plus args flows to the provider as a normal user turn.
//!
//! Non-slash input always returns `Passthrough` so regular chat keeps
//! flowing.

use super::slash_catalog::{self, CATALOG, MenuKind, SlashKind};

/// What the event loop should do after the user presses Enter on a
/// `/slash-form` input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashAction {
    /// Wipe the conversation history and re-splash the mascot. Does
    /// NOT exit the TUI.
    Clear,
    /// Exit the TUI gracefully. Covers both `/exit` and `/bye`.
    Exit,
    /// Show the slash catalog inline. Retained for 012c menu handlers
    /// that may want to render the old inline help text; CATALOG no
    /// longer emits this directly (`/help` is `InteractiveMenu(Help)`).
    ShowHelp,
    /// `/model` with no argument. Retained for 012c menu commit path.
    ShowModel,
    /// `/model <id>` — switch the active model. Retained for 012c menu
    /// commit path.
    SwitchModel(String),
    /// `/compact` — drop prior messages.
    Compact,
    /// `/status` — inline render of statusline state. Retained for 012c.
    ShowStatus,
    /// `/context` — inline context-usage breakdown. Retained for 012c.
    ShowContext,
    /// `/config`, `/keybindings`, `/statusline` — hint-file surface.
    /// Retained for 012c.
    ShowSettingsHint(String),
    /// `/login <provider>` — loop emits instructions to run auth CLI.
    Login(String),
    /// `/logout <provider>` — ditto.
    Logout(String),
    /// `/rewind` / `/checkpoint` — upstream `type: 'local'`; 012a stubs
    /// with a muted inline note, 012c wires the real session-history
    /// reset.
    Rewind,
    /// `/keybindings` — inline text listing active bindings.
    ShowKeybindings,
    /// `/verbose` — toggle render-verbosity on tool-use messages.
    /// Independent from the CLI `--verbose` logging flag; mirrors
    /// upstream's `verbose` render-mode toggled by the same slash.
    ToggleVerbose,
    /// Overlay menu is pending — 012a fallback. The event loop renders
    /// a muted inline note identifying the slash by name. 012b replaces
    /// this variant with real `ActiveMenu` state + modal key handler.
    MenuPending(MenuKind),
    /// Pass this raw text through to the LLM as a normal user prompt —
    /// the `/` prefix is part of the message.
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
            SlashKind::InteractiveMenu(kind) => SlashAction::MenuPending(kind),
            SlashKind::AiRouted => SlashAction::SendToLlm(input.to_string()),
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
    fn bye_stays_local_exit() {
        // User decision 2026-04-18 — `/bye` is an otherside-native local
        // alias of `/exit`, NOT promoted to `AiRouted` or routed through
        // the ExitConfirm menu. Provides immediate-effect UX.
        assert_eq!(classify("/bye"), SlashAction::Exit);
    }

    #[test]
    fn exit_is_confirm_menu() {
        assert_eq!(
            classify("/exit"),
            SlashAction::MenuPending(MenuKind::ExitConfirm)
        );
    }

    #[test]
    fn compact_is_local() {
        assert_eq!(classify("/compact"), SlashAction::Compact);
    }

    #[test]
    fn help_is_menu_not_plain_text() {
        assert_eq!(
            classify("/help"),
            SlashAction::MenuPending(MenuKind::Help)
        );
    }

    #[test]
    fn model_does_not_leak_to_llm() {
        // Regression guard — previous session routed `/model` to
        // AiRouted which echoed the literal slash at the provider. The
        // three-taxonomy mirror restores the correct menu routing.
        assert_eq!(
            classify("/model"),
            SlashAction::MenuPending(MenuKind::Model)
        );
        // Args do NOT flip the routing. `/model claude-opus-4-7[1m]`
        // still opens the picker; selection happens in the menu.
        assert_eq!(
            classify("/model claude-opus-4-7[1m]"),
            SlashAction::MenuPending(MenuKind::Model)
        );
    }

    #[test]
    fn permissions_does_not_leak_to_llm() {
        assert_eq!(
            classify("/permissions"),
            SlashAction::MenuPending(MenuKind::Permissions)
        );
    }

    #[test]
    fn rewind_is_local_not_ai() {
        assert_eq!(classify("/rewind"), SlashAction::Rewind);
    }

    #[test]
    fn checkpoint_aliases_rewind() {
        assert_eq!(classify("/checkpoint"), SlashAction::Rewind);
        assert_eq!(classify("/checkpoint"), classify("/rewind"));
    }

    #[test]
    fn keybindings_is_local_emit_text() {
        assert_eq!(classify("/keybindings"), SlashAction::ShowKeybindings);
    }

    #[test]
    fn statusline_is_ai_routed() {
        // Upstream `commands/statusline.tsx` is `type: 'prompt'` — it
        // generates a statusline config via the model. Preserve that
        // routing.
        match classify("/statusline") {
            SlashAction::SendToLlm(s) => assert_eq!(s, "/statusline"),
            other => panic!("expected SendToLlm, got {other:?}"),
        }
    }

    #[test]
    fn ai_routed_slash_passes_through_to_llm() {
        // `/security` is upstream `type: 'prompt'`; `/cron` is
        // otherside-native AiRouted. Both preserve the `/` prefix.
        match classify("/security check the auth module") {
            SlashAction::SendToLlm(s) => {
                assert!(s.starts_with("/security"));
                assert!(s.contains("check the auth module"));
            }
            other => panic!("expected SendToLlm, got {other:?}"),
        }
        match classify("/cron daily") {
            SlashAction::SendToLlm(s) => assert!(s.starts_with("/cron")),
            other => panic!("expected SendToLlm, got {other:?}"),
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
    fn slash_case_insensitive() {
        assert_eq!(classify("/CLEAR"), SlashAction::Clear);
        assert_eq!(
            classify("/Help"),
            SlashAction::MenuPending(MenuKind::Help)
        );
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
    fn no_catalog_row_returns_passthrough() {
        // Passthrough is reserved for non-slash input. Every CATALOG
        // row MUST classify to one of: Local variant, MenuPending, or
        // SendToLlm.
        for entry in slash_catalog::CATALOG {
            let action = classify(&format!("/{}", entry.name));
            assert!(
                !matches!(action, SlashAction::Passthrough),
                "/{} leaked to Passthrough: {action:?}",
                entry.name
            );
        }
    }

    #[test]
    fn every_interactive_menu_row_produces_menu_pending() {
        // Every SlashKind::InteractiveMenu(kind) row classifies to
        // SlashAction::MenuPending(kind) with the matching MenuKind —
        // no drift between catalog and classifier.
        for entry in slash_catalog::CATALOG {
            if let SlashKind::InteractiveMenu(expected_kind) = entry.kind {
                match classify(&format!("/{}", entry.name)) {
                    SlashAction::MenuPending(got_kind) => {
                        assert_eq!(
                            got_kind, expected_kind,
                            "MenuKind drift for /{}: got {got_kind:?}, expected {expected_kind:?}",
                            entry.name
                        );
                    }
                    other => panic!(
                        "/{} expected MenuPending({expected_kind:?}), got {other:?}",
                        entry.name
                    ),
                }
            }
        }
    }

    #[test]
    fn classification_table_locks_every_row() {
        // Per-entry classification lock. If a CATALOG row's expected
        // action drifts, this test names the offender.
        //
        // Discriminant = name of the SlashAction variant. Where a
        // variant carries data, we pin the data only when it's
        // deterministic (MenuPending carries a MenuKind).
        use SlashAction as A;
        let expected: &[(&str, A)] = &[
            ("help", A::MenuPending(MenuKind::Help)),
            ("clear", A::Clear),
            ("exit", A::MenuPending(MenuKind::ExitConfirm)),
            ("bye", A::Exit),
            ("compact", A::Compact),
            ("resume", A::MenuPending(MenuKind::Resume)),
            ("rewind", A::Rewind),
            ("branch", A::MenuPending(MenuKind::Branch)),
            ("copy", A::MenuPending(MenuKind::Copy)),
            ("export", A::MenuPending(MenuKind::Export)),
            ("checkpoint", A::Rewind),
            ("config", A::MenuPending(MenuKind::Config)),
            ("model", A::MenuPending(MenuKind::Model)),
            ("effort", A::MenuPending(MenuKind::Effort)),
            ("plan", A::MenuPending(MenuKind::Plan)),
            ("permissions", A::MenuPending(MenuKind::Permissions)),
            ("hooks", A::MenuPending(MenuKind::Hooks)),
            ("keybindings", A::ShowKeybindings),
            ("verbose", A::ToggleVerbose),
            ("sandbox", A::MenuPending(MenuKind::Sandbox)),
            ("statusline", A::SendToLlm("/statusline".into())),
            ("diff", A::MenuPending(MenuKind::Diff)),
            ("scope", A::SendToLlm("/scope".into())),
            ("security", A::SendToLlm("/security".into())),
            ("pr-review", A::SendToLlm("/pr-review".into())),
            ("deepreview", A::SendToLlm("/deepreview".into())),
            ("init", A::SendToLlm("/init".into())),
            ("skills", A::MenuPending(MenuKind::Skills)),
            ("agents", A::MenuPending(MenuKind::Agents)),
            ("init-verifiers", A::SendToLlm("/init-verifiers".into())),
            ("context", A::MenuPending(MenuKind::Context)),
            ("status", A::MenuPending(MenuKind::Status)),
            ("mcp", A::MenuPending(MenuKind::Mcp)),
            ("login", A::MenuPending(MenuKind::Login)),
            ("logout", A::MenuPending(MenuKind::Logout)),
            ("dedup-mem", A::SendToLlm("/dedup-mem".into())),
            ("cron", A::SendToLlm("/cron".into())),
            ("redteam", A::SendToLlm("/redteam".into())),
            ("swarm", A::SendToLlm("/swarm".into())),
        ];
        for (name, expected_action) in expected {
            let got = classify(&format!("/{name}"));
            assert_eq!(
                got, *expected_action,
                "/{name} classification drift: got {got:?}, expected {expected_action:?}"
            );
        }
        // Sanity: every CATALOG row is covered.
        assert_eq!(
            expected.len(),
            slash_catalog::CATALOG.len(),
            "classification table missing rows vs CATALOG ({} vs {})",
            expected.len(),
            slash_catalog::CATALOG.len()
        );
    }
}
