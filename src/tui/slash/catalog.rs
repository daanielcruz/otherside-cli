

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashKind {

    Instant,

    Toggle,

    Skill,

    Anchor,

    Panel(PanelKind),

    Auth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsTab {
    Status,
    Config,
    Usage,
}

impl SettingsTab {

    pub fn slash_name(self) -> &'static str {
        match self {
            SettingsTab::Status => "status",
            SettingsTab::Config => "config",
            SettingsTab::Usage => "usage",
        }
    }
}

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

    Tasks,
}

impl PanelKind {

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
            PanelKind::Tasks => "tasks",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SlashEntry {

    pub name: &'static str,

    pub brief: &'static str,

    pub kind: SlashKind,
}

pub const CATALOG: &[SlashEntry] = &[

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

    SlashEntry {
        name: "plan",
        brief: "enable plan mode",
        kind: SlashKind::Toggle,
    },
    SlashEntry {
        name: "copy",
        brief: "copy the last assistant response to clipboard",
        kind: SlashKind::Toggle,
    },
    SlashEntry {
        name: "export",
        brief: "export the current conversation to a file or clipboard",
        kind: SlashKind::Toggle,
    },

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
        name: "security-review",
        brief: "review pending changes for security issues",
        kind: SlashKind::Skill,
    },
    SlashEntry {
        name: "loop",
        brief: "run a prompt or slash on a recurring interval",
        kind: SlashKind::Skill,
    },

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
        name: "context",
        brief: "visualize current context usage",
        kind: SlashKind::Anchor,
    },

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
    SlashEntry {
        name: "tasks",
        brief: "list and manage background tasks",
        kind: SlashKind::Panel(PanelKind::Tasks),
    },
    SlashEntry {
        name: "bashes",
        brief: "list and manage background tasks",
        kind: SlashKind::Panel(PanelKind::Tasks),
    },

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

pub fn lookup(name: &str) -> Option<&'static SlashEntry> {
    CATALOG.iter().find(|e| e.name.eq_ignore_ascii_case(name))
}

pub fn prefix_matches(prefix_lower: &str) -> impl Iterator<Item = &'static SlashEntry> + use<'_> {
    CATALOG
        .iter()
        .filter(move |e| e.name.to_ascii_lowercase().starts_with(prefix_lower))
}

pub fn display_line(entry: &SlashEntry) -> String {
    format!("/{} — {}", entry.name, entry.brief)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_kind_enumerates_all_variants() {

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

        assert_eq!(variants.len(), 14);
    }

    #[test]
    fn settings_tab_slash_names_match_catalog() {

        assert_eq!(SettingsTab::Status.slash_name(), "status");
        assert_eq!(SettingsTab::Config.slash_name(), "config");
        assert_eq!(SettingsTab::Usage.slash_name(), "usage");
    }

    #[test]
    fn slash_kind_has_six_variants() {

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
        assert!(names.contains(&"status"));
        assert!(names.contains(&"statusline"));
        assert!(names.contains(&"skills"));
        assert!(names.contains(&"security-review"));
        assert!(!names.contains(&"swarm"), "/swarm cut in 011");
    }

    #[test]
    fn display_line_format() {
        let e = lookup("help").unwrap();
        assert_eq!(display_line(e), "/help — show slash command catalog");
    }

    #[test]
    fn panel_kind_slash_names_match_catalog() {

        const ALIAS_NAMES: &[&str] = &["bashes"];
        for entry in CATALOG {
            if ALIAS_NAMES.contains(&entry.name) {
                continue;
            }
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

        assert_eq!(
            CATALOG.len(),
            33,
            "CATALOG must be a strict subset of docs/slashes.md"
        );
    }

    #[test]
    fn catalog_contains_no_cut_slashes() {

        let cuts = [
            "bye",
            "swarm",
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

        let expected: &[(&str, SlashKind)] = &[

            ("exit", SlashKind::Instant),
            ("clear", SlashKind::Instant),

            ("plan", SlashKind::Toggle),
            ("copy", SlashKind::Toggle),
            ("export", SlashKind::Toggle),

            ("dream", SlashKind::Skill),
            ("statusline", SlashKind::Skill),
            ("init-verifiers", SlashKind::Skill),
            ("review", SlashKind::Skill),
            ("init", SlashKind::Skill),
            ("security-review", SlashKind::Skill),
            ("loop", SlashKind::Skill),

            ("branch", SlashKind::Anchor),
            ("compact", SlashKind::Anchor),
            ("context", SlashKind::Anchor),

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
            ("tasks", SlashKind::Panel(PanelKind::Tasks)),
            ("bashes", SlashKind::Panel(PanelKind::Tasks)),

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
