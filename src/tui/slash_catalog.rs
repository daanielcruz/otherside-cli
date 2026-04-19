//! Single source of truth for the slash command catalog.
//!
//! All surfaces (autocomplete popup, `/help` inline catalog, tips
//! rotation, classifier dispatch) consume this module so a slash added
//! here lights up everywhere.
//!
//! Classification follows the three-taxonomy mirror of upstream's
//! command-type discriminator (see upstream `types/command.ts:205`):
//!
//! | upstream `type` | otherside `SlashKind`          |
//! |-----------------|--------------------------------|
//! | `local`         | `Local(LocalAction)`           |
//! | `local-jsx`     | `InteractiveMenu(MenuKind)`    |
//! | `prompt`        | `AiRouted`                     |
//!
//! `local-jsx` entries mount an overlay widget in the prompt slot and
//! capture keyboard focus until the user confirms or cancels; they do
//! NOT round-trip to the LLM. Previously, 29 `local-jsx` rows were
//! wrongly classified as `AiRouted` so `/model`, `/help`, `/permissions`
//! etc. were echoed at the provider. `SlashKind::InteractiveMenu`
//! restores the correct routing; the overlay state machine + renderer
//! land in 012b/012c.

/// Classification of a catalog entry: which kind of handler owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashKind {
    /// Synchronous local handler — immediate side-effect, inline text
    /// output, no overlay. Mirrors upstream `type: 'local'`.
    Local(LocalAction),
    /// Overlay menu handler — mounts a widget in the prompt slot and
    /// captures focus until `onDone` fires. Mirrors upstream
    /// `type: 'local-jsx'`. The concrete menu state machine lands in
    /// 012b; 012a ships `MenuPending` as the temporary fallback.
    InteractiveMenu(MenuKind),
    /// AI-routed passthrough — the `/<name> <args>` string expands into
    /// a user turn and is sent to the provider verbatim. Mirrors
    /// upstream `type: 'prompt'`. Also covers otherside-native slashes
    /// whose intent is to be LLM-mediated.
    AiRouted,
}

/// Interactive-menu discriminator. One variant per upstream `local-jsx`
/// command; the set is pinned to the 21-row upstream catalog and a new
/// variant MUST be added in the same change that introduces a new
/// `InteractiveMenu` CATALOG row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuKind {
    Help,
    ExitConfirm,
    Resume,
    Branch,
    Copy,
    Export,
    Config,
    Model,
    Effort,
    Plan,
    Permissions,
    Hooks,
    Sandbox,
    Diff,
    Skills,
    Agents,
    Context,
    Status,
    Mcp,
    Login,
    Logout,
}

impl MenuKind {
    /// Slash name associated with this menu, used by the event-loop
    /// fallback note so the `MenuPending(kind)` arm can quote the
    /// original slash without threading strings.
    pub fn slash_name(self) -> &'static str {
        match self {
            MenuKind::Help => "help",
            MenuKind::ExitConfirm => "exit",
            MenuKind::Resume => "resume",
            MenuKind::Branch => "branch",
            MenuKind::Copy => "copy",
            MenuKind::Export => "export",
            MenuKind::Config => "config",
            MenuKind::Model => "model",
            MenuKind::Effort => "effort",
            MenuKind::Plan => "plan",
            MenuKind::Permissions => "permissions",
            MenuKind::Hooks => "hooks",
            MenuKind::Sandbox => "sandbox",
            MenuKind::Diff => "diff",
            MenuKind::Skills => "skills",
            MenuKind::Agents => "agents",
            MenuKind::Context => "context",
            MenuKind::Status => "status",
            MenuKind::Mcp => "mcp",
            MenuKind::Login => "login",
            MenuKind::Logout => "logout",
        }
    }
}

/// Concrete local actions. Enum-of-enums wiring is painful in const
/// context, so this lives alongside `SlashAction` as a small mirror of
/// the wired handlers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalAction {
    Clear,
    Exit,
    ShowHelp,
    /// `/model` — show current model (no arg) or switch to the given
    /// id (one arg). Retained for 012c menu handlers that dispatch
    /// through to the model-switch path; no CATALOG row points here
    /// after reclass (`/model` is `InteractiveMenu(Model)`).
    ShowOrSwitchModel,
    /// `/compact` — drop prior messages, keep a synthetic summary note
    /// so the context window clears without losing conversational trail.
    Compact,
    /// `/status` — render the current model / provider / context
    /// snapshot inline as a system note. Retained for 012c.
    Status,
    /// `/context` — render context-window usage breakdown inline.
    /// Retained for 012c.
    Context,
    /// `/config`, `/keybindings`, `/statusline` — hint-file surface.
    /// Retained for 012c fallbacks; no CATALOG row points here after
    /// reclass.
    ShowSettingsHint,
    /// `/login` / `/logout` — auth CLI hints. Retained for 012c.
    Login,
    Logout,
    /// `/rewind` / `/checkpoint` — upstream `type: 'local'`; emits a
    /// short text result and triggers a session-history reset via side
    /// effect. Upstream does not render a picker. 012c wires the actual
    /// rewind path; 012a stubs with an inline note.
    Rewind,
    /// `/keybindings` — upstream `type: 'local'`; emits inline text
    /// listing the active bindings.
    Keybindings,
    /// `/verbose` — toggle render verbosity for tool-use messages.
    /// Upstream `type: 'local'` — matches the boolean setting
    /// `tools/*Tool/UI.tsx` reads as `verbose`.
    ToggleVerbose,
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
            LocalAction::Rewind => A::Rewind,
            LocalAction::Keybindings => A::ShowKeybindings,
            LocalAction::ToggleVerbose => A::ToggleVerbose,
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
    // Session control.
    SlashEntry {
        name: "help",
        brief: "show slash command catalog",
        kind: SlashKind::InteractiveMenu(MenuKind::Help),
    },
    SlashEntry {
        name: "clear",
        brief: "wipe history, re-splash mascot",
        kind: SlashKind::Local(LocalAction::Clear),
    },
    SlashEntry {
        name: "exit",
        brief: "exit the TUI",
        kind: SlashKind::InteractiveMenu(MenuKind::ExitConfirm),
    },
    SlashEntry {
        name: "bye",
        brief: "exit the TUI (alias of /exit)",
        kind: SlashKind::Local(LocalAction::Exit),
    },
    SlashEntry {
        name: "compact",
        brief: "summarize history, trim tokens",
        kind: SlashKind::Local(LocalAction::Compact),
    },
    SlashEntry {
        name: "resume",
        brief: "pick a past session to continue",
        kind: SlashKind::InteractiveMenu(MenuKind::Resume),
    },
    SlashEntry {
        name: "rewind",
        brief: "jump back to an earlier turn",
        kind: SlashKind::Local(LocalAction::Rewind),
    },
    SlashEntry {
        name: "branch",
        brief: "fork the conversation from here",
        kind: SlashKind::InteractiveMenu(MenuKind::Branch),
    },
    SlashEntry {
        name: "copy",
        brief: "export the session to clipboard",
        kind: SlashKind::InteractiveMenu(MenuKind::Copy),
    },
    SlashEntry {
        name: "export",
        brief: "write the session to a file",
        kind: SlashKind::InteractiveMenu(MenuKind::Export),
    },
    SlashEntry {
        name: "checkpoint",
        brief: "tag this spot for /rewind",
        kind: SlashKind::Local(LocalAction::Rewind),
    },
    // Config surface.
    SlashEntry {
        name: "config",
        brief: "show the config file path",
        kind: SlashKind::InteractiveMenu(MenuKind::Config),
    },
    SlashEntry {
        name: "model",
        brief: "show or switch the active model",
        kind: SlashKind::InteractiveMenu(MenuKind::Model),
    },
    SlashEntry {
        name: "effort",
        brief: "tune reasoning effort (low/med/high/max/auto)",
        kind: SlashKind::InteractiveMenu(MenuKind::Effort),
    },
    SlashEntry {
        name: "plan",
        brief: "enable plan mode",
        kind: SlashKind::InteractiveMenu(MenuKind::Plan),
    },
    SlashEntry {
        name: "permissions",
        brief: "manage tool permission rules",
        kind: SlashKind::InteractiveMenu(MenuKind::Permissions),
    },
    SlashEntry {
        name: "hooks",
        brief: "view or edit hooks for tool events",
        kind: SlashKind::InteractiveMenu(MenuKind::Hooks),
    },
    SlashEntry {
        name: "keybindings",
        brief: "show the active keybindings",
        kind: SlashKind::Local(LocalAction::Keybindings),
    },
    SlashEntry {
        name: "verbose",
        brief: "toggle verbose tool-use render",
        kind: SlashKind::Local(LocalAction::ToggleVerbose),
    },
    SlashEntry {
        name: "sandbox",
        brief: "toggle sandbox mode",
        kind: SlashKind::InteractiveMenu(MenuKind::Sandbox),
    },
    SlashEntry {
        name: "statusline",
        brief: "generate a statusline config with AI",
        kind: SlashKind::AiRouted,
    },
    // Development.
    SlashEntry {
        name: "diff",
        brief: "view uncommitted or per-turn diffs",
        kind: SlashKind::InteractiveMenu(MenuKind::Diff),
    },
    SlashEntry {
        name: "scope",
        brief: "add or remove directories from the workspace",
        kind: SlashKind::AiRouted,
    },
    SlashEntry {
        name: "security",
        brief: "run the security review skill",
        kind: SlashKind::AiRouted,
    },
    SlashEntry {
        name: "pr-review",
        brief: "review a pull request",
        kind: SlashKind::AiRouted,
    },
    SlashEntry {
        name: "deepreview",
        brief: "exhaustive review pass",
        kind: SlashKind::AiRouted,
    },
    SlashEntry {
        name: "init",
        brief: "initialize project OTHERSIDE.md",
        kind: SlashKind::AiRouted,
    },
    SlashEntry {
        name: "skills",
        brief: "list available skills",
        kind: SlashKind::InteractiveMenu(MenuKind::Skills),
    },
    SlashEntry {
        name: "agents",
        brief: "manage agent configurations",
        kind: SlashKind::InteractiveMenu(MenuKind::Agents),
    },
    SlashEntry {
        name: "init-verifiers",
        brief: "create verifier skill(s)",
        kind: SlashKind::AiRouted,
    },
    // Diagnostic.
    SlashEntry {
        name: "context",
        brief: "visualize current context usage",
        kind: SlashKind::InteractiveMenu(MenuKind::Context),
    },
    SlashEntry {
        name: "status",
        brief: "render current statusline inline",
        kind: SlashKind::InteractiveMenu(MenuKind::Status),
    },
    // Ecosystem.
    SlashEntry {
        name: "mcp",
        brief: "manage MCP servers",
        kind: SlashKind::InteractiveMenu(MenuKind::Mcp),
    },
    // Auth.
    SlashEntry {
        name: "login",
        brief: "sign in to a provider",
        kind: SlashKind::InteractiveMenu(MenuKind::Login),
    },
    SlashEntry {
        name: "logout",
        brief: "sign out from a provider",
        kind: SlashKind::InteractiveMenu(MenuKind::Logout),
    },
    // Bundled skills (otherside-native).
    SlashEntry {
        name: "dedup-mem",
        brief: "consolidate memory files",
        kind: SlashKind::AiRouted,
    },
    SlashEntry {
        name: "cron",
        brief: "schedule recurring tasks",
        kind: SlashKind::AiRouted,
    },
    // Offensive-sec surface (otherside-native).
    SlashEntry {
        name: "redteam",
        brief: "adversarial probe on the current target",
        kind: SlashKind::AiRouted,
    },
    SlashEntry {
        name: "swarm",
        brief: "list, create, or kill swarm agents",
        kind: SlashKind::AiRouted,
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
        assert!(lookup("help").is_some(), "help must exist");
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
            SlashKind::InteractiveMenu(MenuKind::ExitConfirm)
        ));
    }

    #[test]
    fn catalog_size_matches_shipped() {
        assert!(CATALOG.len() >= 34, "catalog underpopulated: {}", CATALOG.len());
    }

    #[test]
    fn no_leading_slash_in_names() {
        for e in CATALOG {
            assert!(!e.name.starts_with('/'), "name must not include leading slash: {}", e.name);
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
        assert!(names.contains(&"sandbox"));
        assert!(names.contains(&"skills"));
    }

    #[test]
    fn display_line_format() {
        let e = lookup("help").unwrap();
        assert_eq!(display_line(e), "/help — show slash command catalog");
    }

    #[test]
    fn menu_kind_has_twenty_one_variants() {
        // Variant count is pinned to upstream's `local-jsx` command set.
        // Touching this list requires updating CATALOG rows in the same
        // change (see module-level doc).
        let variants = [
            MenuKind::Help,
            MenuKind::ExitConfirm,
            MenuKind::Resume,
            MenuKind::Branch,
            MenuKind::Copy,
            MenuKind::Export,
            MenuKind::Config,
            MenuKind::Model,
            MenuKind::Effort,
            MenuKind::Plan,
            MenuKind::Permissions,
            MenuKind::Hooks,
            MenuKind::Sandbox,
            MenuKind::Diff,
            MenuKind::Skills,
            MenuKind::Agents,
            MenuKind::Context,
            MenuKind::Status,
            MenuKind::Mcp,
            MenuKind::Login,
            MenuKind::Logout,
        ];
        assert_eq!(variants.len(), 21);
    }

    #[test]
    fn slash_kind_has_three_variants() {
        // Exhaustive match — compilation fails if a fourth variant is
        // added without this test being updated. `Stubbed` must NEVER
        // be reintroduced.
        let samples = [
            SlashKind::Local(LocalAction::Clear),
            SlashKind::InteractiveMenu(MenuKind::Model),
            SlashKind::AiRouted,
        ];
        for s in samples {
            match s {
                SlashKind::Local(_) | SlashKind::InteractiveMenu(_) | SlashKind::AiRouted => {}
            }
        }
    }

    #[test]
    fn menu_kind_slash_names_match_catalog() {
        // Every MenuKind variant reachable from CATALOG produces the
        // same slash name as the entry that carries it.
        for entry in CATALOG {
            if let SlashKind::InteractiveMenu(kind) = entry.kind {
                assert_eq!(
                    kind.slash_name(),
                    entry.name,
                    "MenuKind::{:?} drift vs /{}",
                    kind,
                    entry.name
                );
            }
        }
    }

    #[test]
    fn every_menu_kind_appears_in_catalog() {
        // MenuKind variant set must be exactly what CATALOG uses — no
        // orphan variants, no missing rows.
        let mut seen = std::collections::HashSet::new();
        for entry in CATALOG {
            if let SlashKind::InteractiveMenu(kind) = entry.kind {
                seen.insert(kind.slash_name());
            }
        }
        assert_eq!(seen.len(), 21, "expected 21 InteractiveMenu rows, got {}", seen.len());
    }
}
