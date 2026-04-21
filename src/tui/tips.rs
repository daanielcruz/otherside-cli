

use ratatui::{
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use super::render::theme;
use super::slash::catalog::{self, CATALOG};

pub fn tip_at(index: usize) -> String {
    if CATALOG.is_empty() {
        return String::new();
    }
    catalog::display_line(&CATALOG[index % CATALOG.len()])
}

pub fn draw(f: &mut Frame<'_>, area: Rect, rotation_index: usize) {
    let tip = tip_at(rotation_index);
    let line = Line::from(vec![
        Span::styled("Tip: ", Style::default().fg(theme::MUTED)),
        Span::styled(tip, Style::default().fg(theme::MUTED)),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tip_at_wraps_around() {
        let zero = tip_at(0);
        let wrap = tip_at(CATALOG.len());
        assert_eq!(zero, wrap);
    }

    #[test]
    fn every_rendered_tip_has_slash_prefix() {
        for i in 0..CATALOG.len() {
            let tip = tip_at(i);
            assert!(tip.starts_with('/'), "tip missing slash: {tip:?}");
        }
    }

    #[test]
    fn every_rendered_tip_has_brief() {
        for i in 0..CATALOG.len() {
            let tip = tip_at(i);
            assert!(
                tip.contains(" — "),
                "tip missing em-dash brief separator: {tip:?}"
            );
        }
    }

    #[test]
    fn tips_cover_full_catalog() {

        let mut seen = std::collections::HashSet::new();
        for i in 0..CATALOG.len() {
            seen.insert(tip_at(i));
        }
        assert_eq!(seen.len(), CATALOG.len());
    }
}
