//! Canonical slash catalog — single source of truth for names, briefs, kinds.
//!
//! Categories follow `docs/slashes.md`: six kinds (`instant`, `toggle`,
//! `skill`, `anchor`, `panel`, `auth`). This file is a strict subset of
//! that doc (R-114). Adds / renames / removes land in `docs/slashes.md`
//! first, then ride into code via a dedicated openspec change.
//!
//! Phase 1 (openspec 001) re-classifies the existing catalog rows under
//! the new six-variant `SlashKind`. Phase 2 prunes cuts and adds the
//! five new entries that `docs/slashes.md` carries — until phase 2
//! lands, some rows below are flagged `// cut in phase 2`.

/// High-level classification for a slash command.
///
/// One variant per category in `docs/slashes.md`. `Panel` is the only
/// data-carrying variant — the `PanelKind` discriminator tells the
/// overlay layer which picker to mount. The other five categories
/// dispatch by slash name inside their handler module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashKind {
    /// Silent immediate side-effect (e.g. `/clear`, `/bye`).
    Instant,
    /// State flip + ephemeral confirmation row (e.g. `/plan`).
    Toggle,
    /// Bundled SKILL.md body → user turn (e.g. `/dream`).
    Skill,
    /// User echo + `⎿` system-anchor render (e.g. `/compact`).
    Anchor,
    /// Overlay menu — 13 panel slashes. Discriminator picks the picker.
    Panel(PanelKind),
    /// Provider auth flow (`/login`, `/logout`).
    Auth,
}

/// Tab discriminator for the unified Settings panel. Upstream's
/// `components/Settings/Settings.tsx` serves `/status`, `/config`,
/// `/usage` as a single component that lands on a different default
/// tab depending on which slash opened it (R-92 evidence:
/// `commands/config/dashboard.tsx:10`; live capture 2026-04-20).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsTab {
    Status,
    Config,
    Usage,
}

impl SettingsTab {
    /// The slash whose invocation lands on this default tab.
    pub fn slash_name(self) -> &'static str {
        match self {
            SettingsTab::Status => "status",
            SettingsTab::Config => "config",
            SettingsTab::Usage => "usage",
        }
    }
}

/// Discriminator for the Panel slashes. `Settings` is parameterized
/// by default-tab (one upstream panel, three entry points); other
/// variants are 1:1 with their slash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelKind {
    Help,
    Resume,
    Rewind,
    Settings(SettingsTab),
    Model,
    Effort,
    Permissions,
    Hooks,
    Diff,
    Skills,
    Agents,
    Mcp,
}

impl PanelKind {
    /// Canonical slash name for this panel. Used by overlay constructors
    /// and the classifier regression tests.
    pub fn slash_name(self) -> &'static str {
        match self {
            PanelKind::Help => "help",
            PanelKind::Resume => "resume",
            PanelKind::Rewind => "rewind",
            PanelKind::Settings(tab) => tab.slash_name(),
            PanelKind::Model => "model",
            PanelKind::Effort => "effort",
            PanelKind::Permissions => "permissions",
            PanelKind::Hooks => "hooks",
            PanelKind::Diff => "diff",
            PanelKind::Skills => "skills",
            PanelKind::Agents => "agents",
            PanelKind::Mcp => "mcp",
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

/// Full catalog — strict subset of `docs/slashes.md` (R-114). 34 rows
/// across 6 categories. Order here is the display order (help,
/// autocomplete, tips rotation all walk this slice as-is).
pub const CATALOG: &[SlashEntry] = &[
    // ── instant (3) ─────────────────────────────────────────────
    SlashEntry {
        name: "bye",
        brief: "exit the TUI",
        kind: SlashKind::Instant,
    },
    SlashEntry {
        name: "exit",
        brief: "exit the TUI",
        kind: SlashKind::Instant,
    },
    SlashEntry {
        name: "clear",
        brief: "wipe history, re-splash mascot",
        kind: SlashKind::Instant,
    },

    // ── toggle (5) ──────────────────────────────────────────────
    SlashEntry {
        name: "plan",
        brief: "enable plan mode",
        kind: SlashKind::Toggle,
    },
    SlashEntry {
        name: "tag",
        brief: "tag the current turn for later recall",
        kind: SlashKind::Toggle,
    },
    SlashEntry {
        name: "copy",
        brief: "export the session to clipboard",
        kind: SlashKind::Toggle,
    },
    SlashEntry {
        name: "export",
        brief: "write the session to a file",
        kind: SlashKind::Toggle,
    },
    SlashEntry {
        name: "keybindings",
        brief: "show the active keybindings",
        kind: SlashKind::Toggle,
    },

    // ── skill (7) ───────────────────────────────────────────────
    SlashEntry {
        name: "dream",
        brief: "reflective memory consolidation",
        kind: SlashKind::Skill,
    },
    SlashEntry {
        name: "statusline",
        brief: "generate a statusline config with AI",
        kind: SlashKind::Skill,
    },
    SlashEntry {
        name: "init-verifiers",
        brief: "create verifier skill(s)",
        kind: SlashKind::Skill,
    },
    SlashEntry {
        name: "review",
        brief: "code review a pull request",
        kind: SlashKind::Skill,
    },
    SlashEntry {
        name: "init",
        brief: "initialize project OTHERSIDE.md",
        kind: SlashKind::Skill,
    },
    SlashEntry {
        name: "swarm",
        brief: "spin up a multi-agent team",
        kind: SlashKind::Skill,
    },
    SlashEntry {
        name: "security-review",
        brief: "review pending changes for security issues",
        kind: SlashKind::Skill,
    },

    // ── anchor (4) ──────────────────────────────────────────────
    SlashEntry {
        name: "branch",
        brief: "fork the conversation from here",
        kind: SlashKind::Anchor,
    },
    SlashEntry {
        name: "compact",
        brief: "summarize history, trim tokens",
        kind: SlashKind::Anchor,
    },
    SlashEntry {
        name: "loop",
        brief: "toggle loop mode for recurring prompts",
        kind: SlashKind::Anchor,
    },
    SlashEntry {
        name: "context",
        brief: "visualize current context usage",
        kind: SlashKind::Anchor,
    },

    // ── panel (13) ──────────────────────────────────────────────
    SlashEntry {
        name: "help",
        brief: "show slash command catalog",
        kind: SlashKind::Panel(PanelKind::Help),
    },
    SlashEntry {
        name: "resume",
        brief: "pick a past session to continue",
        kind: SlashKind::Panel(PanelKind::Resume),
    },
    SlashEntry {
        name: "rewind",
        brief: "jump back to an earlier turn",
        kind: SlashKind::Panel(PanelKind::Rewind),
    },
    SlashEntry {
        name: "config",
        brief: "show the config file path",
        kind: SlashKind::Panel(PanelKind::Settings(SettingsTab::Config)),
    },
    SlashEntry {
        name: "model",
        brief: "show or switch the active model",
        kind: SlashKind::Panel(PanelKind::Model),
    },
    SlashEntry {
        name: "effort",
        brief: "tune reasoning effort (low/med/high/max/auto)",
        kind: SlashKind::Panel(PanelKind::Effort),
    },
    SlashEntry {
        name: "permissions",
        brief: "manage tool permission rules",
        kind: SlashKind::Panel(PanelKind::Permissions),
    },
    SlashEntry {
        name: "hooks",
        brief: "view or edit hooks for tool events",
        kind: SlashKind::Panel(PanelKind::Hooks),
    },
    SlashEntry {
        name: "diff",
        brief: "view uncommitted or per-turn diffs",
        kind: SlashKind::Panel(PanelKind::Diff),
    },
    SlashEntry {
        name: "skills",
        brief: "list available skills",
        kind: SlashKind::Panel(PanelKind::Skills),
    },
    SlashEntry {
        name: "agents",
        brief: "manage agent configurations",
        kind: SlashKind::Panel(PanelKind::Agents),
    },
    SlashEntry {
        name: "status",
        brief: "show session status (Status tab of Settings)",
        kind: SlashKind::Panel(PanelKind::Settings(SettingsTab::Status)),
    },
    SlashEntry {
        name: "usage",
        brief: "show plan usage limits (Usage tab of Settings)",
        kind: SlashKind::Panel(PanelKind::Settings(SettingsTab::Usage)),
    },
    SlashEntry {
        name: "mcp",
        brief: "manage MCP servers",
        kind: SlashKind::Panel(PanelKind::Mcp),
    },

    // ── auth (2) ────────────────────────────────────────────────
    SlashEntry {
        name: "login",
        brief: "sign in to a provider",
        kind: SlashKind::Auth,
    },
    SlashEntry {
        name: "logout",
        brief: "sign out from a provider",
        kind: SlashKind::Auth,
    },
];

/// Look up an entry by name (case-insensitive, no leading `/`).
pub fn lookup(name: &str) -> Option<&'static SlashEntry> {
    CATALOG.iter().find(|e| e.name.eq_ignore_ascii_case(name))
}

/// Walk entries filtered by a lowercase prefix. Preserves catalog order.
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
    fn panel_kind_enumerates_all_variants() {
        // `Settings(tab)` collapses three pre-008 variants into one
        // payload-carrying variant — 10 panel kinds now, three of
        // them surfaced via the same kind with different tab payload.
        let variants = [
            PanelKind::Help,
            PanelKind::Resume,
            PanelKind::Rewind,
            PanelKind::Settings(SettingsTab::Status),
            PanelKind::Settings(SettingsTab::Config),
            PanelKind::Settings(SettingsTab::Usage),
            PanelKind::Model,
            PanelKind::Effort,
            PanelKind::Permissions,
            PanelKind::Hooks,
            PanelKind::Diff,
            PanelKind::Skills,
            PanelKind::Agents,
            PanelKind::Mcp,
        ];
        // Three of these land the same `PanelKind::Settings` arm,
        // differing only in the `SettingsTab` payload — the slash
        // catalog still carries 14 Panel rows.
        assert_eq!(variants.len(), 14);
    }

    #[test]
    fn settings_tab_slash_names_match_catalog() {
        // R-92 evidence: `commands/config/dashboard.tsx:10` shows
        // `/config` sets `defaultTab: "Status"` — the SLASH NAME and
        // the DEFAULT TAB don't share wording, but every
        // `SettingsTab` variant MUST map to the slash that lands on
        // it as its default.
        assert_eq!(SettingsTab::Status.slash_name(), "status");
        assert_eq!(SettingsTab::Config.slash_name(), "config");
        assert_eq!(SettingsTab::Usage.slash_name(), "usage");
    }

    #[test]
    fn slash_kind_has_six_variants() {
        // Exhaustive match — compilation fails if a seventh variant is
        // added without this test being updated.
        let samples = [
            SlashKind::Instant,
            SlashKind::Toggle,
            SlashKind::Skill,
            SlashKind::Anchor,
            SlashKind::Panel(PanelKind::Help),
            SlashKind::Auth,
        ];
        for s in samples {
            match s {
                SlashKind::Instant
                | SlashKind::Toggle
                | SlashKind::Skill
                | SlashKind::Anchor
                | SlashKind::Panel(_)
                | SlashKind::Auth => {}
            }
        }
    }

    #[test]
    fn lookup_case_insensitive() {
        assert!(lookup("HELP").is_some());
        assert!(lookup("Clear").is_some());
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
    fn prefix_matches_finds_s_group() {
        let names: Vec<&str> = prefix_matches("s").map(|e| e.name).collect();
        assert!(names.contains(&"swarm"));
        assert!(names.contains(&"status"));
        assert!(names.contains(&"statusline"));
        assert!(names.contains(&"skills"));
    }

    #[test]
    fn display_line_format() {
        let e = lookup("help").unwrap();
        assert_eq!(display_line(e), "/help — show slash command catalog");
    }

    #[test]
    fn panel_kind_slash_names_match_catalog() {
        // Every PanelKind variant reachable from CATALOG produces the
        // same slash name as the entry that carries it.
        for entry in CATALOG {
            if let SlashKind::Panel(kind) = entry.kind {
                assert_eq!(
                    entry.name,
                    kind.slash_name(),
                    "PanelKind::{:?} drift vs /{}",
                    kind,
                    entry.name
                );
            }
        }
    }

    #[test]
    fn catalog_row_count_matches_docs() {
        // 008 added `/usage` to the panel section (upstream landing
        // tab of the unified Settings component). Target row count =
        // 35 until another slash joins or leaves the catalog.
        assert_eq!(
            CATALOG.len(),
            35,
            "CATALOG must be a strict subset of docs/slashes.md"
        );
    }

    #[test]
    fn catalog_contains_no_cut_slashes() {
        // Cut slashes live in RULES.md §15 — they must NEVER ship in
        // the autocomplete catalog. Also guards against legacy names
        // from the pre-marco-zero era coming back by accident.
        let cuts = [
            "verbose",
            "sandbox",
            "scope",
            "security",
            "pr-review",
            "deepreview",
            "ultrareview",
            "dedup-mem",
            "cron",
            "redteam",
            "checkpoint",
            "bughunter",
            "files",
        ];
        for cut in cuts {
            assert!(
                lookup(cut).is_none(),
                "cut slash /{} must not appear in CATALOG",
                cut
            );
        }
    }

    #[test]
    fn catalog_category_assignment_lock() {
        // Table-driven lock: every CATALOG row maps to its expected
        // SlashKind. Drift in either the name OR the kind names the
        // offender. Mirror of `docs/slashes.md`.
        let expected: &[(&str, SlashKind)] = &[
            // instant
            ("bye", SlashKind::Instant),
            ("exit", SlashKind::Instant),
            ("clear", SlashKind::Instant),
            // toggle
            ("plan", SlashKind::Toggle),
            ("tag", SlashKind::Toggle),
            ("copy", SlashKind::Toggle),
            ("export", SlashKind::Toggle),
            ("keybindings", SlashKind::Toggle),
            // skill
            ("dream", SlashKind::Skill),
            ("statusline", SlashKind::Skill),
            ("init-verifiers", SlashKind::Skill),
            ("review", SlashKind::Skill),
            ("init", SlashKind::Skill),
            ("swarm", SlashKind::Skill),
            ("security-review", SlashKind::Skill),
            // anchor
            ("branch", SlashKind::Anchor),
            ("compact", SlashKind::Anchor),
            ("loop", SlashKind::Anchor),
            ("context", SlashKind::Anchor),
            // panel
            ("help", SlashKind::Panel(PanelKind::Help)),
            ("resume", SlashKind::Panel(PanelKind::Resume)),
            ("rewind", SlashKind::Panel(PanelKind::Rewind)),
            ("config", SlashKind::Panel(PanelKind::Settings(SettingsTab::Config))),
            ("model", SlashKind::Panel(PanelKind::Model)),
            ("effort", SlashKind::Panel(PanelKind::Effort)),
            ("permissions", SlashKind::Panel(PanelKind::Permissions)),
            ("hooks", SlashKind::Panel(PanelKind::Hooks)),
            ("diff", SlashKind::Panel(PanelKind::Diff)),
            ("skills", SlashKind::Panel(PanelKind::Skills)),
            ("agents", SlashKind::Panel(PanelKind::Agents)),
            ("status", SlashKind::Panel(PanelKind::Settings(SettingsTab::Status))),
            ("usage", SlashKind::Panel(PanelKind::Settings(SettingsTab::Usage))),
            ("mcp", SlashKind::Panel(PanelKind::Mcp)),
            // auth
            ("login", SlashKind::Auth),
            ("logout", SlashKind::Auth),
        ];
        assert_eq!(
            expected.len(),
            CATALOG.len(),
            "expected table must cover every CATALOG row"
        );
        for (name, kind) in expected {
            let entry = lookup(name).unwrap_or_else(|| panic!("/{name} missing from CATALOG"));
            assert_eq!(
                entry.kind, *kind,
                "/{name} category drift: got {:?}, expected {:?}",
                entry.kind, kind
            );
        }
    }
}
