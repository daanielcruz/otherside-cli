

use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};

use super::render::theme;

const DIFF_ADDED_BG: Color = Color::Rgb(34, 92, 43);

const DIFF_REMOVED_BG: Color = Color::Rgb(122, 41, 54);

pub const MAX_LINES: usize = 100;

pub fn render_unified(fragment: &str) -> Vec<Line<'static>> {
    let all: Vec<&str> = fragment.lines().collect();
    let total = all.len();
    let (visible, overflow) = if total > MAX_LINES {
        (&all[..MAX_LINES], total - MAX_LINES)
    } else {
        (&all[..], 0)
    };

    let mut lines: Vec<Line<'static>> = visible
        .iter()
        .map(|raw| style_diff_line(raw))
        .collect();

    if overflow > 0 {
        lines.push(Line::from(Span::styled(
            format!("  … {overflow} more lines …"),
            Style::default().fg(theme::MUTED).add_modifier(Modifier::ITALIC),
        )));
    }
    lines
}

fn style_diff_line(raw: &str) -> Line<'static> {
    let style = if raw.starts_with('+') && !raw.starts_with("+++") {
        Style::default().fg(theme::DIFF_ADDED).bg(DIFF_ADDED_BG)
    } else if raw.starts_with('-') && !raw.starts_with("---") {
        Style::default().fg(theme::DIFF_REMOVED).bg(DIFF_REMOVED_BG)
    } else if raw.starts_with("@@") {
        Style::default().fg(theme::MUTED).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme::MUTED)
    };
    Line::from(Span::styled(raw.to_string(), style))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_small_diff_shows_all_lines() {
        let frag = "@@ -1,3 +1,3 @@\n line a\n-line b\n+line B\n line c";
        let lines = render_unified(frag);
        assert_eq!(lines.len(), 5);
    }

    #[test]
    fn render_empty_diff_yields_empty_vec() {
        let lines = render_unified("");
        assert!(lines.is_empty());
    }

    #[test]
    fn render_long_diff_collapses_overflow() {
        let many: String = (0..150)
            .map(|i| format!("+line {i}\n"))
            .collect();
        let lines = render_unified(&many);
        assert_eq!(lines.len(), MAX_LINES + 1);
        let last: String = lines
            .last()
            .unwrap()
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(last.contains("50 more lines"));
    }

    #[test]
    fn header_lines_styled_as_header_not_add_remove() {
        let frag = "--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new";
        let lines = render_unified(frag);

        assert_eq!(lines.len(), 5);
    }
}
