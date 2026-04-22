use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::state::{AgentsPanelState, Tab};
use crate::tui::render::theme;

const FOOTER_HINT: &str = "←/→ switch tabs · ↑↓ navigate · Enter select · Esc close";

/// Upstream AgentsList + BackgroundTasksDialog indent body rows 4 cols
/// from pane edge (tab bar + headers indent with 2, content rows with 4).
/// Matches `pngs/02-agents-frame2-library.png` + `frame3-running.png`.
const BODY_INDENT: &str = "    ";
const BODY_HEADER_INDENT: &str = "  ";

pub fn draw_panel(f: &mut Frame<'_>, area: Rect, state: &AgentsPanelState) {
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(6 + state.running.len() + state.library.len());

    lines.push(tab_bar(state.tab, state.running.len()));
    lines.push(Line::from(""));

    match state.tab {
        Tab::Running => lines.extend(running_body(state)),
        Tab::Library => lines.extend(library_body(state)),
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        FOOTER_HINT,
        Style::default().fg(theme::MUTED),
    )));

    let para = Paragraph::new(lines).alignment(Alignment::Left);
    f.render_widget(para, area);
}

fn tab_bar(active: Tab, running_count: usize) -> Line<'static> {
    let title = Span::styled(
        "Agents ",
        Style::default()
            .fg(theme::TEXT)
            .add_modifier(Modifier::BOLD),
    );
    let running_label = if running_count > 0 {
        format!("Running ({running_count})")
    } else {
        "Running".to_string()
    };
    let spans = vec![
        title,
        chip(running_label, matches!(active, Tab::Running)),
        Span::raw(" "),
        chip("Library".to_string(), matches!(active, Tab::Library)),
    ];
    Line::from(spans)
}

fn chip(label: String, selected: bool) -> Span<'static> {
    if selected {
        Span::styled(
            format!(" {label} "),
            Style::default()
                .fg(Color::Black)
                .bg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        )
    } else {
        Span::styled(
            format!(" {label} "),
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        )
    }
}

fn running_body(state: &AgentsPanelState) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    if state.running.is_empty() && state.recently_completed.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(
                "No subagents are currently running.",
                Style::default().fg(theme::MUTED),
            ),
        ]));
    } else {
        for (i, row) in state.running.iter().enumerate() {
            let selected = i == state.running_cursor;
            let prefix = if selected { "▶ " } else { "  " };
            let style = if selected {
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };
            // Upstream row format (AsyncAgentDetailDialog.tsx:106):
            // `{subagent_type} · {description} · {elapsed}s · {tokens} tokens`.
            // `subagent_type` leads — `name` was otherside's legacy stand-in.
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
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{BODY_HEADER_INDENT}{prefix}"),
                    style,
                ),
                Span::styled(segments.join(" · "), style),
            ]));
        }

        if !state.recently_completed.is_empty() {
            if !state.running.is_empty() {
                lines.push(Line::from(""));
            }
            lines.push(Line::from(vec![
                Span::raw(BODY_HEADER_INDENT),
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
                        "✔ ".to_string(),
                        Style::default().fg(theme::SUCCESS),
                    ),
                    Span::styled(
                        segments.join(" · "),
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
        format!("{head}…")
    }
}

fn library_body(state: &AgentsPanelState) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> =
        Vec::with_capacity(state.library.len() + state.user_agents.len() + 8);

    // Upstream ordering (AgentsList.tsx): Create new agent → User agents →
    // Plugin agents → Built-in agents. Sections separated by blank rows.

    // Create new agent (visual placeholder — actual creation flow pending).
    lines.push(Line::from(vec![
        Span::raw(BODY_INDENT),
        Span::styled(
            "Create new agent".to_string(),
            Style::default().fg(theme::MUTED).add_modifier(Modifier::DIM),
        ),
    ]));
    lines.push(Line::from(""));

    // User agents: scanned from ~/.claude/agents/*.md via frontmatter.
    if !state.user_agents.is_empty() {
        let header = match state.user_agents_dir.as_ref() {
            Some(p) => format!("User agents ({})", p.display()),
            None => "User agents".to_string(),
        };
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(header, Style::default().fg(theme::TEXT)),
        ]));
        for row in &state.user_agents {
            lines.push(Line::from(vec![
                Span::raw(BODY_INDENT),
                Span::styled(
                    format!("{} · {} · user memory", row.name, row.model),
                    Style::default().fg(theme::TEXT),
                ),
            ]));
        }
        lines.push(Line::from(""));
    }

    // Plugin agents section is gated behind plugin-manifest discovery
    // (Phase 3). Emit a placeholder header only when state surfaces some
    // future `plugin_agents` vector — for now skip.

    // Built-in agents (always available) — closes the section list.
    lines.push(Line::from(vec![
        Span::raw(BODY_HEADER_INDENT),
        Span::styled(
            "Built-in agents (always available)".to_string(),
            Style::default().fg(theme::TEXT),
        ),
    ]));
    for row in &state.library {
        let mut spans: Vec<Span<'static>> = vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                format!("{} · {}", row.name, row.model),
                Style::default().fg(theme::TEXT),
            ),
        ];
        if row.running_count > 0 {
            spans.push(Span::styled(
                format!(" 🟢 {} running", row.running_count),
                Style::default().fg(theme::SUCCESS),
            ));
        }
        lines.push(Line::from(spans));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::subagents::registry;
    use crate::tasks::TaskStore;

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
        assert!(
            text.trim_start().starts_with("Create new agent"),
            "library tab must open with `Create new agent` selectable row (upstream AgentsList.tsx:33,47-52): {text:?}"
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
    fn tab_bar_lists_title_and_two_chips() {
        let line = tab_bar(Tab::Running, 0);
        let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(joined.contains("Agents"));
        assert!(joined.contains("Running"));
        assert!(joined.contains("Library"));
    }

    #[test]
    fn tab_bar_running_chip_shows_count_when_nonzero() {
        let line = tab_bar(Tab::Running, 2);
        let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(joined.contains("Running (2)"), "missing count: {joined:?}");
    }

    #[test]
    fn tab_bar_running_chip_omits_count_when_zero() {
        let line = tab_bar(Tab::Running, 0);
        let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(!joined.contains("(0)"), "should not render (0): {joined:?}");
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
            text.contains("✔"),
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
            text.contains("general-purpose · Sleep 200 echo ok · 19s"),
            "row must lead with subagent_type then description: {text}"
        );
    }
}
