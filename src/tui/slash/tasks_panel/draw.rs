use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::state::{Mode, TaskRow, TasksPanelState};
use crate::tasks::{TaskKind, TaskState};
use crate::tui::render::theme;

const BODY_HEADER_INDENT: &str = "  ";
const BODY_INDENT: &str = "    ";
const LIST_FOOTER: &str =
    "↑↓ navigate · Enter/→ select · Esc close";
const DETAIL_FOOTER: &str =
    "← to go back · Esc/Enter/Space to close · x to stop";

pub fn draw_panel(f: &mut Frame<'_>, area: Rect, state: &TasksPanelState) {
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(20);
    match state.mode {
        Mode::List => lines.extend(list_body(state)),
        Mode::Detail(_) => lines.extend(detail_body(state)),
    }
    let para = Paragraph::new(lines);
    f.render_widget(para, area);
}

fn list_body(state: &TasksPanelState) -> Vec<Line<'static>> {
    let mut lines = Vec::with_capacity(state.rows.len() + 4);
    lines.push(Line::from(Span::styled(
        format!("{BODY_HEADER_INDENT}Background tasks"),
        Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));

    if state.rows.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(
                "No background tasks running.",
                Style::default().fg(theme::MUTED),
            ),
        ]));
    } else {
        for (i, row) in state.rows.iter().enumerate() {
            let selected = i == state.cursor;
            let prefix = if selected { "▶ " } else { "  " };
            let style = if selected {
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{BODY_HEADER_INDENT}{prefix}"),
                    style,
                ),
                Span::styled(format_list_row(row), style),
            ]));
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        format!("{BODY_HEADER_INDENT}{LIST_FOOTER}"),
        Style::default().fg(theme::MUTED),
    )));
    lines
}

fn detail_body(state: &TasksPanelState) -> Vec<Line<'static>> {
    let mut lines = Vec::with_capacity(20);
    let Some(row) = state.focused_row() else {
        lines.push(Line::from(Span::styled(
            format!("{BODY_HEADER_INDENT}(no task in focus)"),
            Style::default().fg(theme::MUTED),
        )));
        return lines;
    };

    // Title: `{subagent_type} › {description || 'Async agent'}` — mirrors
    // AsyncAgentDetailDialog.tsx:106.
    let lead = row
        .subagent_type
        .clone()
        .unwrap_or_else(|| row.name.clone());
    let title_tail = row
        .description
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| match row.kind {
            TaskKind::Agent => "Async agent".to_string(),
            TaskKind::Shell => "Shell".to_string(),
            TaskKind::Generic => "Task".to_string(),
        });
    lines.push(Line::from(vec![
        Span::raw(BODY_HEADER_INDENT),
        Span::styled(
            format!("{lead} › {title_tail}"),
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ),
    ]));

    // Subtitle: `{elapsed}s · {tokens} tokens · {N} tools` — dimColor.
    // Tool count is output.len() (best approximation of tool-use count
    // until runner streams per-tool events).
    let tool_count = row.output.len();
    let subtitle = format!(
        "{}s · {} tokens · {} tool{}",
        row.runtime_secs,
        crate::tui::tool_render::format_number_compact(row.tokens),
        tool_count,
        if tool_count == 1 { "" } else { "s" },
    );
    lines.push(Line::from(vec![
        Span::raw(BODY_HEADER_INDENT),
        Span::styled(subtitle, Style::default().fg(theme::MUTED)),
    ]));
    lines.push(Line::from(""));

    // Progress section (recent output lines). Prefix the LAST row with
    // `› ` and the earlier rows with `  ` — upstream pattern.
    if !row.output.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(
                "Progress".to_string(),
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            ),
        ]));
        let n = row.output.len();
        // Render up to the last 5 to keep the overlay bounded.
        let start = n.saturating_sub(5);
        for (i, line) in row.output.iter().enumerate().skip(start) {
            let marker = if i + 1 == n { "› " } else { "  " };
            lines.push(Line::from(vec![
                Span::raw(BODY_INDENT),
                Span::styled(
                    format!("{marker}{}", truncate(line, 120)),
                    Style::default().fg(theme::TEXT),
                ),
            ]));
        }
        lines.push(Line::from(""));
    }

    // Prompt section: 300-char truncation with `…`.
    if !row.prompt.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(
                "Prompt".to_string(),
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            ),
        ]));
        let preview = truncate(&row.prompt, 300);
        lines.push(Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(preview, Style::default().fg(theme::MUTED)),
        ]));
        lines.push(Line::from(""));
    }

    // Status line for finished tasks so `← back` is obvious.
    let status_note = match row.state {
        TaskState::Completed => Some("Status: completed"),
        TaskState::Failed => Some("Status: failed"),
        TaskState::Stopped => Some("Status: stopped"),
        TaskState::Running | TaskState::Backgrounded | TaskState::Pending => None,
    };
    if let Some(s) = status_note {
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(
                s.to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ]));
        lines.push(Line::from(""));
    }

    lines.push(Line::from(Span::styled(
        format!("{BODY_HEADER_INDENT}{DETAIL_FOOTER}"),
        Style::default().fg(theme::MUTED),
    )));
    lines
}

fn format_list_row(row: &TaskRow) -> String {
    let mut segments = Vec::with_capacity(4);
    let lead = row
        .subagent_type
        .clone()
        .unwrap_or_else(|| row.name.clone());
    segments.push(lead);
    if let Some(desc) = &row.description {
        segments.push(desc.clone());
    } else if matches!(row.kind, TaskKind::Shell) && !row.prompt.is_empty() {
        segments.push(truncate(&row.prompt, 60));
    }
    segments.push(format!("{}s", row.runtime_secs));
    segments.push(format!(
        "{} tokens",
        crate::tui::tool_render::format_number_compact(row.tokens),
    ));
    segments.join(" · ")
}

fn truncate(s: &str, cap: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= cap {
        return s.to_string();
    }
    let head: String = chars.into_iter().take(cap - 1).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{TaskId, TaskRecord as TR, TaskStore};

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
    fn empty_list_renders_notice_and_footer() {
        let s = TaskStore::new();
        let st = TasksPanelState::new(&s);
        let text = collect_text(&list_body(&st));
        assert!(text.contains("Background tasks"));
        assert!(text.contains("No background tasks running."));
        assert!(text.contains("Esc close"));
    }

    #[test]
    fn list_row_format_matches_upstream_shape() {
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "do stuff".into(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.description = Some("Sleep 200 echo ok".into());
        r.tokens = 22_300;
        s.insert(r);
        let mut st = TasksPanelState::new(&s);
        st.mode = Mode::List;
        let text = collect_text(&list_body(&st));
        assert!(text.contains("▶ "));
        assert!(
            text.contains("general-purpose · Sleep 200 echo ok"),
            "row leads with subagent_type · description: {text}"
        );
        assert!(text.contains("22.3k tokens") || text.contains("22300 tokens"));
    }

    #[test]
    fn detail_carries_title_subtitle_prompt_footer() {
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "Run exactly: `sleep 400 && echo ok`".into(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.description = Some("Sleep 400 echo ok".into());
        r.tokens = 22_100;
        r.push_output("Bash(sleep 400 && echo ok)".into());
        r.push_output("Bash(bash -c 'sleep 400; echo ok')".into());
        s.insert(r);
        let st = TasksPanelState::new(&s);
        assert!(matches!(st.mode, Mode::Detail(0)));
        let text = collect_text(&detail_body(&st));
        assert!(text.contains("general-purpose › Sleep 400 echo ok"));
        assert!(text.contains("22.1k tokens"));
        assert!(text.contains("Progress"));
        assert!(text.contains("› Bash(bash -c 'sleep 400; echo ok')"));
        assert!(text.contains("Prompt"));
        assert!(text.contains("Run exactly"));
        assert!(text.contains(
            "← to go back · Esc/Enter/Space to close · x to stop"
        ));
    }
}
