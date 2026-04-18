//! TodoWrite list rendering. Renders a bulleted checklist with status
//! glyphs inside the streaming area when the assistant emits a
//! TodoWrite ToolResult.

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};
use serde::{Deserialize, Serialize};

use super::render::theme;

/// Todo status values. Matches upstream shape so TodoWrite ToolResults
/// round-trip without translation.
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
    /// Glyph per status. `☐` pending, `◐` in-progress, `☒` completed.
    pub fn glyph(&self) -> char {
        match self {
            TodoStatus::Pending => '☐',
            TodoStatus::InProgress => '◐',
            TodoStatus::Completed => '☒',
        }
    }
}

/// Render a todo list as owned Lines for composition into the
/// streaming area. Returning Lines (not painting a Frame directly)
/// lets the caller intersperse todos with assistant text.
pub fn render_lines(items: &[TodoItem]) -> Vec<Line<'static>> {
    items
        .iter()
        .map(|item| {
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
            Line::from(vec![
                Span::styled(
                    format!("  {} ", item.status.glyph()),
                    Style::default().fg(color).add_modifier(modifier),
                ),
                Span::styled(
                    label.to_string(),
                    Style::default().fg(color).add_modifier(modifier),
                ),
            ])
        })
        .collect()
}

/// Convenience: paint lines into `area` using Paragraph. Caller sizes
/// the Rect to `items.len()`.
pub fn draw(f: &mut Frame<'_>, area: Rect, items: &[TodoItem]) {
    let lines = render_lines(items);
    f.render_widget(Paragraph::new(lines), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_per_status() {
        assert_eq!(TodoStatus::Pending.glyph(), '☐');
        assert_eq!(TodoStatus::InProgress.glyph(), '◐');
        assert_eq!(TodoStatus::Completed.glyph(), '☒');
    }

    #[test]
    fn render_lines_matches_item_count() {
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
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn in_progress_uses_active_form_when_present() {
        let item = TodoItem {
            content: "static label".into(),
            status: TodoStatus::InProgress,
            active_form: Some("live label".into()),
        };
        let lines = render_lines(&[item]);
        let rendered: String = lines[0]
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
