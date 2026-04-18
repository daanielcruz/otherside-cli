//! Rotating tip line below the progress row. Per C47, tips come from
//! otherside's slash catalog (the same `slash_catalog::CATALOG` the
//! classifier and autocomplete popup walk). Random rotation per
//! render, no persistence across sessions.

use ratatui::{
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use super::render::theme;
use super::slash_catalog::{self, CATALOG};

/// Pick a tip by rotation index. Stable across same index so callers
/// control the rotation cadence (typically bump the index on new
/// inference requests, not every render).
pub fn tip_at(index: usize) -> String {
    if CATALOG.is_empty() {
        return String::new();
    }
    slash_catalog::display_line(&CATALOG[index % CATALOG.len()])
}

/// Paint the tip line into `area`. Format: `⎿ Tip: /<slash> — <brief>`.
pub fn draw(f: &mut Frame<'_>, area: Rect, rotation_index: usize) {
    let tip = tip_at(rotation_index);
    let line = Line::from(vec![
        Span::styled("⎿ Tip: ", Style::default().fg(theme::MUTED)),
        Span::styled(tip, Style::default().fg(theme::PRIMARY)),
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
        // Walk the first CATALOG.len() indices and collect distinct
        // tips — every catalog entry must appear exactly once in that
        // range so the rotation visits every slash before looping.
        let mut seen = std::collections::HashSet::new();
        for i in 0..CATALOG.len() {
            seen.insert(tip_at(i));
        }
        assert_eq!(seen.len(), CATALOG.len());
    }
}
