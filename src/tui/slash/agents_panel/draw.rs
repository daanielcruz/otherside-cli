use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use super::state::{AgentsPanelState, CompletedRow, Tab};
use crate::tasks::TaskState;
use crate::tui::render::theme;

const FOOTER_HINT: &str = "←/→ switch tabs · ↑↓ navigate · Enter select · Esc close";

pub fn draw_panel(f: &mut Frame<'_>, area: Rect, state: &AgentsPanelState) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::PRIMARY));
    let inner = block.inner(area);
    f.render_widget(block, area);

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
    f.render_widget(para, inner);
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
    if state.running.is_empty() {
        lines.push(Line::from(Span::styled(
            "No subagents are currently running.",
            Style::default().fg(theme::MUTED),
        )));
    } else {
        for (i, row) in state.running.iter().enumerate() {
            let selected = i == state.running_cursor;
            let prefix = if selected { "▶ " } else { "  " };
            let style = if selected {
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };
            let mut segments: Vec<String> = vec![row.name.clone()];
            if let Some(desc) = &row.description {
                segments.push(desc.clone());
            }
            segments.push(format!("{}s", row.runtime_secs));
            segments.push(format!("{} tokens", crate::tui::tool_render::format_number_compact(row.tokens)));
            lines.push(Line::from(vec![
                Span::styled(prefix.to_string(), style),
                Span::styled(segments.join(" · "), style),
            ]));
        }
    }

    if !state.recently_completed.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Recently completed",
            Style::default()
                .fg(theme::MUTED)
                .add_modifier(Modifier::BOLD),
        )));
        for row in &state.recently_completed {
            lines.push(completed_row_line(row));
        }
    }

    lines
}

fn completed_row_line(row: &CompletedRow) -> Line<'static> {
    let (glyph, glyph_color) = match row.status {
        TaskState::Completed => ("✓ ", theme::SUCCESS),
        TaskState::Failed => ("✗ ", theme::ERROR),
        TaskState::Stopped => ("■ ", theme::MUTED),
        _ => ("  ", theme::MUTED),
    };
    Line::from(vec![
        Span::styled(glyph.to_string(), Style::default().fg(glyph_color)),
        Span::styled(row.name.clone(), Style::default().fg(theme::MUTED)),
    ])
}

fn library_body(state: &AgentsPanelState) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(state.library.len() + 2);
    lines.push(Line::from(Span::styled(
        "Built-in agents (always available)",
        Style::default()
            .fg(theme::MUTED)
            .add_modifier(Modifier::BOLD),
    )));
    for row in &state.library {
        let mut spans: Vec<Span<'static>> = vec![
            Span::styled("  ".to_string(), Style::default().fg(theme::MUTED)),
            Span::styled(
                format!("{} · {}", row.name, row.model),
                Style::default().fg(theme::MUTED),
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
        assert_eq!(collect_text(&lines), "No subagents are currently running.");
    }

    #[test]
    fn library_body_leads_with_built_in_header() {
        let s = AgentsPanelState::new(&TaskStore::new(), registry::all());
        let lines = library_body(&s);
        let text = collect_text(&lines);
        assert!(text.starts_with("Built-in agents (always available)"));
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
            "claude-code-guide",
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
}
