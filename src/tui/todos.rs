

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};
use serde::{Deserialize, Serialize};

use super::render::theme;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

impl TodoStatus {

    pub fn glyph(&self) -> char {
        match self {
            TodoStatus::Pending => '◻',
            TodoStatus::InProgress => '◼',
            TodoStatus::Completed => '✔',
        }
    }
}

pub fn summary_line(items: &[TodoItem]) -> String {
    let mut done = 0usize;
    let mut in_progress = 0usize;
    let mut open = 0usize;
    for item in items {
        match item.status {
            TodoStatus::Completed => done += 1,
            TodoStatus::InProgress => in_progress += 1,
            TodoStatus::Pending => open += 1,
        }
    }
    format!(
        "{} tasks ({done} done, {in_progress} in progress, {open} open)",
        items.len()
    )
}

pub fn render_lines(items: &[TodoItem]) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::with_capacity(items.len() + 1);
    out.push(Line::from(Span::styled(
        summary_line(items),
        Style::default()
            .fg(theme::MUTED)
            .add_modifier(Modifier::BOLD),
    )));
    for item in items {
        let (color, modifier) = match item.status {
            TodoStatus::InProgress => (theme::PRIMARY, Modifier::BOLD),
            TodoStatus::Completed => (theme::MUTED, Modifier::DIM),
            TodoStatus::Pending => (theme::MUTED, Modifier::empty()),
        };
        let label = item
            .active_form
            .as_deref()
            .filter(|_| item.status == TodoStatus::InProgress)
            .unwrap_or(&item.content);
        out.push(Line::from(vec![
            Span::styled(
                format!("  {} ", item.status.glyph()),
                Style::default().fg(color).add_modifier(modifier),
            ),
            Span::styled(
                label.to_string(),
                Style::default().fg(color).add_modifier(modifier),
            ),
        ]));
    }
    out
}

pub fn draw(f: &mut Frame<'_>, area: Rect, items: &[TodoItem]) {
    let lines = render_lines(items);
    f.render_widget(Paragraph::new(lines), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_per_status() {
        assert_eq!(TodoStatus::Pending.glyph(), '◻');
        assert_eq!(TodoStatus::InProgress.glyph(), '◼');
        assert_eq!(TodoStatus::Completed.glyph(), '✔');
    }

    #[test]
    fn render_lines_includes_summary_header() {
        let items = vec![
            TodoItem {
                content: "alpha".into(),
                status: TodoStatus::Pending,
                active_form: None,
            },
            TodoItem {
                content: "beta".into(),
                status: TodoStatus::InProgress,
                active_form: Some("running beta".into()),
            },
            TodoItem {
                content: "gamma".into(),
                status: TodoStatus::Completed,
                active_form: None,
            },
        ];
        let lines = render_lines(&items);
        assert_eq!(lines.len(), 4, "1 header + 3 item rows");
        let header: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(header.contains("3 tasks"));
        assert!(header.contains("1 done"));
        assert!(header.contains("1 in progress"));
        assert!(header.contains("1 open"));
    }

    #[test]
    fn summary_line_matches_counts() {
        let items = vec![
            TodoItem {
                content: "a".into(),
                status: TodoStatus::Pending,
                active_form: None,
            },
            TodoItem {
                content: "b".into(),
                status: TodoStatus::Completed,
                active_form: None,
            },
        ];
        let s = summary_line(&items);
        assert!(s.contains("2 tasks"));
        assert!(s.contains("1 done"));
        assert!(s.contains("0 in progress"));
        assert!(s.contains("1 open"));
    }

    #[test]
    fn in_progress_uses_active_form_when_present() {
        let item = TodoItem {
            content: "static label".into(),
            status: TodoStatus::InProgress,
            active_form: Some("live label".into()),
        };
        let lines = render_lines(&[item]);

        let rendered: String = lines[1]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(rendered.contains("live label"));
        assert!(!rendered.contains("static label"));
    }

    #[test]
    fn todo_json_round_trip() {
        let item = TodoItem {
            content: "run cargo test".into(),
            status: TodoStatus::InProgress,
            active_form: Some("running cargo test".into()),
        };
        let json = serde_json::to_string(&item).unwrap();
        let parsed: TodoItem = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, item);
        assert!(json.contains("\"status\":\"in_progress\""));
    }
}
