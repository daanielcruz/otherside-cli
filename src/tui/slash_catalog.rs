//! Single source of truth for the slash command catalog.
//!
//! All surfaces (autocomplete popup, `/help` inline catalog, tips
//! rotation, classifier dispatch) consume this module so a slash added
//! here lights up everywhere. Previously tips.rs + slashes.rs carried
//! separate hand-curated lists and drifted out of sync — users saw the
//! tip but the classifier treated it as unknown.
//!
//! Entries follow `docs/slash-commands.md` (authoritative catalog) and
//! `MAPPING.md §Slash Commands`. Update this file when a slash is
//! renamed / cut / added; downstream modules pick it up automatically.

/// Classification of a catalog entry: which kind of handler owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashKind {
    /// Local handler wired today. The paired `SlashAction` describes
    /// what the event loop should do on Enter.
    Local(LocalAction),
    /// Recognized but not yet wired — classify yields `NotYetWired`
    /// and the TUI emits an inline "coming soon" note.
    Stubbed,
}

/// Concrete local actions. Enum-of-enums wiring is painful in const
/// context, so this lives alongside `SlashAction` as a small mirror of
/// the handful of wired handlers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalAction {
    Clear,
    Exit,
    ShowHelp,
    /// `/model` — show current model (no arg) or switch to the given
    /// id (one arg). Classifier emits `SwitchModel(Option<String>)` so
    /// the event loop reads the body directly.
    ShowOrSwitchModel,
    /// `/compact` — drop prior messages, keep a synthetic summary note
    /// so the context window clears without losing conversational trail.
    Compact,
    /// `/status` — render the current model / provider / context
    /// snapshot inline as a system note.
    Status,
    /// `/context` — render context-window usage breakdown inline.
    Context,
    /// `/config`, `/keybindings`, `/statusline` — open the user's
    /// settings file hint inline (no interactive editor yet).
    ShowSettingsHint,
    /// `/login` / `/logout` — dispatch the existing auth CLI flows but
    /// inline in the TUI streaming area.
    Login,
    Logout,
}

impl LocalAction {
    /// Resolve the action into a `slashes::SlashAction`, threading the
    /// slash body as `arg` so `/model <id>`, `/login <provider>`, and
    /// the settings-hint variants each get their string.
    pub fn as_action(self, arg: &str) -> super::slashes::SlashAction {
        use super::slashes::SlashAction as A;
        match self {
            LocalAction::Clear => A::Clear,
            LocalAction::Exit => A::Exit,
            LocalAction::ShowHelp => A::ShowHelp,
            LocalAction::ShowOrSwitchModel => {
                if arg.trim().is_empty() {
                    A::ShowModel
                } else {
                    A::SwitchModel(arg.trim().to_string())
                }
            }
            LocalAction::Compact => A::Compact,
            LocalAction::Status => A::ShowStatus,
            LocalAction::Context => A::ShowContext,
            LocalAction::ShowSettingsHint => A::ShowSettingsHint(arg.trim().to_string()),
            LocalAction::Login => A::Login(arg.trim().to_string()),
            LocalAction::Logout => A::Logout(arg.trim().to_string()),
        }
    }
}

/// One slash command in the catalog.
#[derive(Debug, Clone, Copy)]
pub struct SlashEntry {
    /// Slash name without the leading `/`. Lowercase ASCII.
    pub name: &'static str,
    /// User-facing brief shown in `/help` and the autocomplete popup.
    pub brief: &'static str,
    /// Dispatch classification.
    pub kind: SlashKind,
}

/// Full catalog. Order here is the display order (help, autocomplete,
/// tips rotation all walk this slice as-is).
pub const CATALOG: &[SlashEntry] = &[
    // Session control — local handlers live today.
    SlashEntry {
        name: "help",
        brief: "show slash command catalog",
        kind: SlashKind::Local(LocalAction::ShowHelp),
    },
    SlashEntry {
        name: "clear",
        brief: "wipe history, re-splash mascot",
        kind: SlashKind::Local(LocalAction::Clear),
    },
    SlashEntry {
        name: "exit",
        brief: "exit the TUI",
        kind: SlashKind::Local(LocalAction::Exit),
    },
    SlashEntry {
        name: "bye",
        brief: "exit the TUI (alias of /exit)",
        kind: SlashKind::Local(LocalAction::Exit),
    },
    // Session control — stubbed (recognized, not yet wired).
    SlashEntry {
        name: "compact",
        brief: "summarize history, trim tokens",
        kind: SlashKind::Local(LocalAction::Compact),
    },
    SlashEntry {
        name: "resume",
        brief: "pick a past session to continue",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "rewind",
        brief: "jump back to an earlier turn",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "branch",
        brief: "fork the conversation from here",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "copy",
        brief: "export the session to clipboard",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "export",
        brief: "write the session to a file",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "checkpoint",
        brief: "tag this spot for /rewind",
        kind: SlashKind::Stubbed,
    },
    // Config surface.
    SlashEntry {
        name: "config",
        brief: "show the config file path",
        kind: SlashKind::Local(LocalAction::ShowSettingsHint),
    },
    SlashEntry {
        name: "model",
        brief: "show or switch the active model",
        kind: SlashKind::Local(LocalAction::ShowOrSwitchModel),
    },
    SlashEntry {
        name: "effort",
        brief: "tune reasoning effort (low/med/high/max/auto)",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "plan",
        brief: "enable plan mode",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "permissions",
        brief: "manage tool permission rules",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "hooks",
        brief: "view or edit hooks for tool events",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "keybindings",
        brief: "show the keybindings config path",
        kind: SlashKind::Local(LocalAction::ShowSettingsHint),
    },
    SlashEntry {
        name: "sandbox",
        brief: "toggle sandbox mode",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "statusline",
        brief: "show how to configure the statusline",
        kind: SlashKind::Local(LocalAction::ShowSettingsHint),
    },
    // Development.
    SlashEntry {
        name: "diff",
        brief: "view uncommitted or per-turn diffs",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "scope",
        brief: "add or remove directories from the workspace",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "security",
        brief: "run the security review skill",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "pr-review",
        brief: "review a pull request",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "deepreview",
        brief: "exhaustive review pass",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "init",
        brief: "initialize project OTHERSIDE.md",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "skills",
        brief: "list available skills",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "agents",
        brief: "manage agent configurations",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "init-verifiers",
        brief: "create verifier skill(s)",
        kind: SlashKind::Stubbed,
    },
    // Diagnostic.
    SlashEntry {
        name: "context",
        brief: "visualize current context usage",
        kind: SlashKind::Local(LocalAction::Context),
    },
    SlashEntry {
        name: "status",
        brief: "render current statusline inline",
        kind: SlashKind::Local(LocalAction::Status),
    },
    // Ecosystem.
    SlashEntry {
        name: "mcp",
        brief: "manage MCP servers",
        kind: SlashKind::Stubbed,
    },
    // Auth.
    SlashEntry {
        name: "login",
        brief: "sign in to a provider",
        kind: SlashKind::Local(LocalAction::Login),
    },
    SlashEntry {
        name: "logout",
        brief: "sign out from a provider",
        kind: SlashKind::Local(LocalAction::Logout),
    },
    // Bundled skills (renamed from upstream).
    SlashEntry {
        name: "dedup-mem",
        brief: "consolidate memory files",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "learn",
        brief: "alias of /dedup-mem",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "cron",
        brief: "schedule recurring tasks",
        kind: SlashKind::Stubbed,
    },
    // Bundled skills kept verbatim.
    SlashEntry {
        name: "simplify",
        brief: "review for reuse/quality, then fix",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "verify",
        brief: "run verification checks",
        kind: SlashKind::Stubbed,
    },
    SlashEntry {
        name: "update-config",
        brief: "interactive settings.json editor",
        kind: SlashKind::Stubbed,
    },
    // ANT-promoted to external surface.
    SlashEntry {
        name: "redteam",
        brief: "adversarial probe on the current target",
        kind: SlashKind::Stubbed,
    },
    // otherside-native.
    SlashEntry {
        name: "swarm",
        brief: "list, create, or kill swarm agents",
        kind: SlashKind::Stubbed,
    },
];

/// Look up an entry by name (case-insensitive, no leading `/`).
pub fn lookup(name: &str) -> Option<&'static SlashEntry> {
    CATALOG.iter().find(|e| e.name.eq_ignore_ascii_case(name))
}

/// Walk entries filtered by a lowercase prefix. Preserves catalog order
/// so common slashes stay visually stable in the popup.
pub fn prefix_matches(prefix_lower: &str) -> impl Iterator<Item = &'static SlashEntry> + use<'_> {
    CATALOG
        .iter()
        .filter(move |e| e.name.to_ascii_lowercase().starts_with(prefix_lower))
}

/// Render one entry as the `/<name> — <brief>` string used by tips and
/// autocomplete display logic.
pub fn display_line(entry: &SlashEntry) -> String {
    format!("/{} — {}", entry.name, entry.brief)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_local_handlers() {
        assert!(
            lookup("help").is_some(),
            "help must exist"
        );
        assert!(matches!(
            lookup("clear").unwrap().kind,
            SlashKind::Local(LocalAction::Clear)
        ));
        assert!(matches!(
            lookup("bye").unwrap().kind,
            SlashKind::Local(LocalAction::Exit)
        ));
        assert!(matches!(
            lookup("exit").unwrap().kind,
            SlashKind::Local(LocalAction::Exit)
        ));
    }

    #[test]
    fn catalog_size_matches_shipped() {
        // Ship-list per docs/slash-commands.md §Summary + /bye alias.
        // If this number changes, update docs/slash-commands.md AND
        // MAPPING.md §Slash Commands in the same change.
        assert!(CATALOG.len() >= 34, "catalog underpopulated: {}", CATALOG.len());
    }

    #[test]
    fn no_leading_slash_in_names() {
        for e in CATALOG {
            assert!(
                !e.name.starts_with('/'),
                "name must not include leading slash: {}",
                e.name
            );
        }
    }

    #[test]
    fn names_are_ascii_lowercase() {
        for e in CATALOG {
            assert!(
                e.name.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "non-lowercase or non-ascii name: {}",
                e.name
            );
        }
    }

    #[test]
    fn names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for e in CATALOG {
            assert!(seen.insert(e.name), "duplicate slash name: {}", e.name);
        }
    }

    #[test]
    fn briefs_non_empty() {
        for e in CATALOG {
            assert!(!e.brief.is_empty(), "brief missing for /{}", e.name);
        }
    }

    #[test]
    fn lookup_case_insensitive() {
        assert!(lookup("HELP").is_some());
        assert!(lookup("Clear").is_some());
    }

    #[test]
    fn prefix_matches_finds_s_group() {
        let names: Vec<&str> = prefix_matches("s").map(|e| e.name).collect();
        assert!(names.contains(&"scope"));
        assert!(names.contains(&"security"));
        assert!(names.contains(&"swarm"));
        assert!(names.contains(&"status"));
        assert!(names.contains(&"statusline"));
        assert!(names.contains(&"simplify"));
        assert!(names.contains(&"sandbox"));
        assert!(names.contains(&"skills"));
    }

    #[test]
    fn display_line_format() {
        let e = lookup("help").unwrap();
        assert_eq!(display_line(e), "/help — show slash command catalog");
    }
}
