use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::Frame;

use super::state::{AgentsPanelState, BuiltInAgentSnapshot, LibraryDetailKind, Tab};
use crate::tui::panel_frame::{body_row, PanelFrame, TabSpec};
use crate::tui::render::theme;
use ratatui::style::Modifier;

/// Body-row label indent. PanelFrame body rows carry a 2-col chevron
/// prefix already; we indent section headers and non-selectable rows
/// one extra column so the columns align with chevron-prefixed rows.
const BODY_INDENT: &str = "  ";

pub fn draw_panel(f: &mut Frame<'_>, area: Rect, state: &AgentsPanelState) {
    if let Some(kind) = state.detail {
        draw_library_detail(f, area, state, kind);
        return;
    }
    let running_label = running_tab_label(state.running.len());
    let tabs: Vec<TabSpec<'_>> = vec![
        TabSpec { label: &running_label },
        TabSpec { label: "Library" },
    ];
    let active_tab = match state.tab {
        Tab::Running => 0,
        Tab::Library => 1,
    };

    let body: Vec<Line<'static>> = match state.tab {
        Tab::Running => running_body(state),
        Tab::Library => library_body(state),
    };

    let footer_hints: &[(&str, &str)] = &[
        ("\u{2190}/\u{2192}", "switch tabs"),
        ("\u{2191}\u{2193}", "navigate"),
        ("Enter", "select"),
        ("Esc", "close"),
    ];

    let panel = PanelFrame {
        title: Some("Agents"),
        tabs: Some(&tabs),
        active_tab,
        tabs_focused: false,
        search: None,
        body,
        footer_hints,
        pagination_hint: None,
    };
    panel.render(f, area);
}

fn draw_library_detail(
    f: &mut Frame<'_>,
    area: Rect,
    state: &AgentsPanelState,
    kind: LibraryDetailKind,
) {
    let (title, body) = match kind {
        LibraryDetailKind::CreateNewAgent => (
            "Agents \u{203A} Create new agent".to_string(),
            create_new_agent_placeholder_body(),
        ),
        LibraryDetailKind::UserAgent(idx) => {
            let row = state.user_agents.get(idx);
            let title = row
                .map(|r| format!("Agents \u{203A} {}", r.name))
                .unwrap_or_else(|| "Agents \u{203A} user agent".to_string());
            let body = user_agent_detail_body(row);
            (title, body)
        }
        LibraryDetailKind::BuiltIn(idx) => {
            let snap = state.builtin_defs.get(idx);
            let title = snap
                .map(|s| format!("Agents \u{203A} {}", s.name))
                .unwrap_or_else(|| "Agents \u{203A} built-in agent".to_string());
            let body = builtin_detail_body(snap);
            (title, body)
        }
    };
    let footer_hints: &[(&str, &str)] = &[
        ("\u{2190}/Esc", "back to list"),
    ];
    let panel = PanelFrame {
        title: Some(&title),
        tabs: None,
        active_tab: 0,
        tabs_focused: false,
        search: None,
        body,
        footer_hints,
        pagination_hint: None,
    };
    panel.render(f, area);
}

fn create_new_agent_placeholder_body() -> Vec<Line<'static>> {
    vec![
        Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "Agent creation wizard is not yet available on otherside.".to_string(),
                Style::default().fg(theme::TEXT),
            ),
        ]),
        Line::from(""),
        Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "Create a file under `~/.claude/agents/<name>.md` with the usual"
                    .to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ]),
        Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "frontmatter (`name`, `description`, `tools`, `model`) — it surfaces"
                    .to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ]),
        Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "under the User agents section on next panel open.".to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ]),
    ]
}

fn user_agent_detail_body(
    row: Option<&super::state::UserAgentRow>,
) -> Vec<Line<'static>> {
    let Some(row) = row else {
        return vec![Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "(row not found)".to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ])];
    };
    vec![
        kv_line("Model", &row.model),
        kv_line("Source", "user memory"),
        Line::from(""),
        Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "Detail view for user agents is read-only on otherside.".to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ]),
        Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                format!(
                    "Edit the markdown source at `~/.claude/agents/{}.md`.",
                    row.name
                ),
                Style::default().fg(theme::MUTED),
            ),
        ]),
    ]
}

fn builtin_detail_body(snap: Option<&BuiltInAgentSnapshot>) -> Vec<Line<'static>> {
    let Some(snap) = snap else {
        return vec![Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "(row not found)".to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ])];
    };
    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(kv_line("Model", &snap.model));
    let tools_str = if snap.tools_wildcard {
        "(all tools)".to_string()
    } else if snap.tools.is_empty() {
        "(none)".to_string()
    } else {
        snap.tools.join(", ")
    };
    lines.push(kv_line("Tools", &tools_str));
    lines.push(Line::from(""));
    lines.push(section_header("Description"));
    for body_line in snap.description.lines() {
        lines.push(detail_body_line(body_line));
    }
    lines.push(Line::from(""));
    lines.push(section_header("Prompt"));
    for body_line in snap.prompt.lines().take(30) {
        lines.push(detail_body_line(body_line));
    }
    lines
}

fn kv_line(key: &str, value: &str) -> Line<'static> {
    Line::from(vec![
        Span::raw(BODY_INDENT),
        Span::styled(
            format!("{key}: "),
            Style::default().fg(theme::MUTED),
        ),
        Span::styled(value.to_string(), Style::default().fg(theme::TEXT)),
    ])
}

fn section_header(label: &str) -> Line<'static> {
    Line::from(vec![
        Span::raw(BODY_INDENT),
        Span::styled(
            label.to_string(),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        ),
    ])
}

fn detail_body_line(text: &str) -> Line<'static> {
    Line::from(vec![
        Span::raw("    "),
        Span::styled(text.to_string(), Style::default().fg(theme::TEXT)),
    ])
}

/// Compose the `Running` tab label, appending `(N)` when N > 0. Kept
/// as a small helper so tests can pin the format without re-rendering.
pub(super) fn running_tab_label(count: usize) -> String {
    if count > 0 {
        format!("Running ({count})")
    } else {
        "Running".to_string()
    }
}

fn running_body(state: &AgentsPanelState) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    if state.running.is_empty() && state.recently_completed.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "No subagents are currently running.",
                Style::default().fg(theme::MUTED),
            ),
        ]));
    } else {
        for (i, row) in state.running.iter().enumerate() {
            let selected = i == state.running_cursor;
            // Upstream row format (AsyncAgentDetailDialog.tsx:106):
            // `{subagent_type} · {description} · {elapsed}s · {tokens} tokens`.
            let mut segments: Vec<String> = Vec::with_capacity(4);
            let lead = row
                .subagent_type
                .clone()
                .unwrap_or_else(|| row.name.clone());
            segments.push(lead);
            if let Some(desc) = &row.description {
                segments.push(desc.clone());
            }
            segments.push(format!("{}s", row.runtime_secs));
            segments.push(format!(
                "{} tokens",
                crate::tui::tool_render::format_number_compact(row.tokens),
            ));
            lines.push(body_row(segments.join(" · "), false, selected));
        }

        if !state.recently_completed.is_empty() {
            if !state.running.is_empty() {
                lines.push(Line::from(""));
            }
            lines.push(Line::from(vec![
                Span::raw(BODY_INDENT),
                Span::styled(
                    "Recently completed".to_string(),
                    Style::default().fg(theme::TEXT),
                ),
            ]));
            for row in &state.recently_completed {
                let lead = row
                    .subagent_type
                    .clone()
                    .unwrap_or_else(|| row.name.clone());
                let mut segments: Vec<String> = vec![lead];
                if let Some(msg) = row
                    .final_message
                    .as_ref()
                    .filter(|s| !s.trim().is_empty())
                {
                    segments.push(truncate_completed(msg));
                }
                lines.push(Line::from(vec![
                    Span::raw(BODY_INDENT),
                    Span::styled(
                        "\u{2714} ".to_string(),
                        Style::default().fg(theme::SUCCESS),
                    ),
                    Span::styled(
                        segments.join(" \u{00B7} "),
                        Style::default().fg(theme::TEXT),
                    ),
                ]));
            }
        }
    }

    lines
}

fn truncate_completed(s: &str) -> String {
    // Upstream Recently-completed shows the first line of final_message,
    // capped. We cap at 80 chars to keep the row in a single terminal row.
    let first_line = s.lines().next().unwrap_or("");
    const CAP: usize = 80;
    if first_line.chars().count() <= CAP {
        first_line.to_string()
    } else {
        let head: String = first_line.chars().take(CAP - 1).collect();
        format!("{head}\u{2026}")
    }
}

fn library_body(state: &AgentsPanelState) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> =
        Vec::with_capacity(state.library.len() + state.user_agents.len() + 8);

    // Upstream ordering (AgentsList.tsx): Create new agent → User agents →
    // Plugin agents → Built-in agents. Sections separated by blank rows.
    //
    // Selection cursor walks a flat index across the 3 selectable kinds:
    // 0 = `Create new agent`, 1..=user_agents.len() = user, rest = built-ins.
    // Section-header and blank rows are non-selectable; the cursor index
    // lives on AgentsPanelState.library_cursor and increments per rendered
    // selectable row.
    let cursor = state.library_cursor;
    let mut flat_idx: usize = 0;

    lines.push(body_row(
        "Create new agent".to_string(),
        flat_idx == cursor,
        false,
    ));
    flat_idx += 1;
    lines.push(Line::from(""));

    if !state.user_agents.is_empty() {
        let header = match state.user_agents_dir.as_ref() {
            Some(p) => format!("User agents ({})", p.display()),
            None => "User agents".to_string(),
        };
        lines.push(Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(header, Style::default().fg(theme::TEXT)),
        ]));
        for row in &state.user_agents {
            lines.push(body_row(
                format!("{} \u{00B7} {} \u{00B7} user memory", row.name, row.model),
                flat_idx == cursor,
                false,
            ));
            flat_idx += 1;
        }
        lines.push(Line::from(""));
    }

    // Built-in agents (always available) — closes the section list.
    lines.push(Line::from(vec![
        Span::raw(BODY_INDENT),
        Span::styled(
            "Built-in agents (always available)".to_string(),
            Style::default().fg(theme::TEXT),
        ),
    ]));
    for row in &state.library {
        let label = if row.running_count > 0 {
            format!(
                "{} \u{00B7} {}  \u{1F7E2} {} running",
                row.name, row.model, row.running_count
            )
        } else {
            format!("{} \u{00B7} {}", row.name, row.model)
        };
        lines.push(body_row(label, flat_idx == cursor, false));
        flat_idx += 1;
    }
    let _ = flat_idx;
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::subagents::registry;
    use crate::tasks::TaskStore;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use ratatui::style::Color;
    use ratatui::Terminal;

    fn collect_text(lines: &[Line<'_>]) -> String {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn render_panel(state: &AgentsPanelState, width: u16, height: u16) -> Buffer {
        let backend = TestBackend::new(width, height);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| {
            let area = Rect::new(0, 0, width, height);
            draw_panel(f, area, state);
        })
        .unwrap();
        term.backend().buffer().clone()
    }

    #[test]
    fn running_body_prints_empty_notice_when_no_tasks() {
        let s = AgentsPanelState::new(&TaskStore::new(), registry::all());
        let lines = running_body(&s);
        let text = collect_text(&lines);
        assert!(
            text.trim_start().starts_with("No subagents are currently running."),
            "empty-state notice missing or shifted: {text:?}"
        );
    }

    #[test]
    fn library_body_contains_built_in_header() {
        let s = AgentsPanelState::new(&TaskStore::new(), registry::all());
        let lines = library_body(&s);
        let text = collect_text(&lines);
        assert!(
            text.contains("Built-in agents (always available)"),
            "built-in section header missing: {text:?}"
        );
    }

    #[test]
    fn library_body_leads_with_create_new_agent() {
        let s = AgentsPanelState::new(&TaskStore::new(), registry::all());
        let lines = library_body(&s);
        let text = collect_text(&lines);
        let first_line = text.lines().next().unwrap_or("");
        assert!(
            first_line.contains("Create new agent"),
            "first row must carry `Create new agent` (upstream AgentsList.tsx:33,47-52): {text:?}"
        );
    }

    #[test]
    fn library_body_lists_every_bundled_name() {
        let s = AgentsPanelState::new(&TaskStore::new(), registry::all());
        let lines = library_body(&s);
        let text = collect_text(&lines);
        for name in [
            "general-purpose",
            "Explore",
            "Plan",
            "verification",
            "statusline-setup",
        ] {
            assert!(text.contains(name), "library missing {name}: {text}");
        }
    }

    #[test]
    fn running_tab_label_shows_count_when_nonzero() {
        assert_eq!(running_tab_label(2), "Running (2)");
    }

    #[test]
    fn running_tab_label_omits_count_when_zero() {
        assert_eq!(running_tab_label(0), "Running");
    }

    #[test]
    fn recently_completed_section_renders_when_populated() {
        use crate::tasks::TaskState;
        let mut s = AgentsPanelState::new(&TaskStore::new(), registry::all());
        s.recently_completed.push(super::super::state::CompletedRow {
            name: "call1".into(),
            status: TaskState::Completed,
            subagent_type: Some("general-purpose".into()),
            final_message: Some(
                "Monitor is running. I'll wait for the notification.".into(),
            ),
        });
        let lines = running_body(&s);
        let text = collect_text(&lines);
        assert!(
            text.contains("Recently completed"),
            "section header missing: {text}"
        );
        assert!(
            text.contains("\u{2714}"),
            "completed marker missing: {text}"
        );
        assert!(
            text.contains("general-purpose"),
            "subagent_type missing from completed row: {text}"
        );
        assert!(
            text.contains("Monitor is running"),
            "final_message excerpt missing: {text}"
        );
    }

    #[test]
    fn running_row_leads_with_subagent_type_when_present() {
        let mut s = AgentsPanelState::new(&TaskStore::new(), registry::all());
        s.running.push(super::super::state::RunningRow {
            name: "ignored-name".into(),
            runtime_secs: 19,
            description: Some("Sleep 200 echo ok".into()),
            tokens: 22_300,
            subagent_type: Some("general-purpose".into()),
        });
        let lines = running_body(&s);
        let text = collect_text(&lines);
        // Upstream row: `{subagent_type} · {description} · {elapsed}s · {tokens}`
        assert!(
            text.contains("general-purpose \u{00B7} Sleep 200 echo ok \u{00B7} 19s"),
            "row must lead with subagent_type then description: {text}"
        );
    }

    #[test]
    fn agents_panel_uses_panel_frame_chrome() {
        // Full-panel render — assert PanelFrame slots:
        //   y=0 top rule in theme::PRIMARY
        //   y=1 blank padding row
        //   y=body_y selected running row with SUCCESS chevron prefix.
        let mut s = AgentsPanelState::new(&TaskStore::new(), registry::all());
        s.tab = Tab::Running;
        s.running.push(super::super::state::RunningRow {
            name: "solo".into(),
            runtime_secs: 5,
            description: Some("one and only".into()),
            tokens: 100,
            subagent_type: Some("general-purpose".into()),
        });
        s.running_cursor = 0;

        let buf = render_panel(&s, 80, 12);

        // y=0 top rule glyph + color.
        let rule_cell = buf[(3, 0)].clone();
        assert_eq!(
            rule_cell.symbol(),
            "\u{2500}",
            "y=0 must be top-rule glyph: {rule_cell:?}"
        );
        assert_eq!(
            rule_cell.fg,
            Color::Rgb(0x3E, 0xA0, 0xC3),
            "top rule fg must be theme::PRIMARY: {rule_cell:?}"
        );

        // y=1 blank padding row (all spaces).
        let mut row1 = String::new();
        for x in 0..80u16 {
            row1.push_str(buf[(x, 1)].symbol());
        }
        assert_eq!(
            row1.trim(),
            "",
            "y=1 must be blank padding row, got {row1:?}"
        );

        // Locate the row containing the selection chevron and assert its
        // foreground color is theme::SUCCESS. Layout:
        //   y=0 rule, y=1 pad, y=2 title, y=3 tabs, y=4 body-first.
        let mut found = false;
        for y in 2..12u16 {
            let cell = buf[(0, y)].clone();
            if cell.symbol() == "\u{276F}" {
                assert_eq!(
                    cell.fg,
                    Color::Rgb(78, 186, 101),
                    "selected body-row chevron must be theme::SUCCESS: {cell:?} at y={y}"
                );
                found = true;
                break;
            }
        }
        assert!(
            found,
            "expected a selected body-row chevron somewhere below the tab row"
        );
    }
}
