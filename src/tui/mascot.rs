//! Splash mascot — the Braille-density corrupted-Rubik's-cube ASCII
//! rendered on launch and after `/clear`. Canonical source is
//! `docs/design/mascot.md` in the outer repo; this constant is the
//! embedded copy with the violet/pink theme applied at draw time.

use ratatui::{
    layout::{Alignment, Rect},
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use super::render::theme;

/// Canonical ASCII mascot — 15 rows tall, 30 columns wide at full size.
/// Uses Braille-density characters so every cell renders at width 1 in
/// a monospaced terminal.
pub const MASCOT: &str = "\
⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⣸⡆⠀⣾⡆⠀⣿⠀⠀⣿⠀⢰⣷⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⣹⡇⠀⣿⡇⠀⣿⠀⠀⣿⠀⢸⣿⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⣰⡿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⢿⣦⠀⠀⠀⠀
⠶⠶⠶⠶⣿⡇⢠⣶⣶⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠶⠶⠶⠶
⣠⣤⣤⣤⣿⡇⠀⠙⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣤⣤⣤⣄
⠀⠀⠀⠈⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠁⠀⠈⠁
⠛⠛⠛⠛⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠛⠛⠛⠛
⠶⠶⠶⠶⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠶⠶⠶⠶
⣀⣤⣤⣤⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣤⣤⣤⣀
⠈⠉⠉⠉⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠉⠉⠉⠁
⠛⠛⠛⠛⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠛⠛⠛⠛
⠴⠶⠶⠶⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠶⠶⠶⠦
⠀⠀⠀⠀⠹⣷⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣾⠟⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⣽⡇⠀⣿⡇⠀⣿⠀⠈⣿⠀⢸⣿⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⢿⡇⠀⢿⠇⠀⣿⠀⠀⣿⠀⠸⡿⠀⠀⠀⠀⠀⠀⠀";

/// Rendered width in columns.
pub const MASCOT_COLS: u16 = 30;
/// Rendered height in lines.
pub const MASCOT_ROWS: u16 = 15;

/// Paint the mascot horizontally centered in `area`, violet throughout.
/// Used on the initial TUI splash.
pub fn draw_splash(f: &mut Frame<'_>, area: Rect) {
    let lines: Vec<Line<'_>> = MASCOT
        .lines()
        .map(|row| {
            Line::from(Span::styled(
                row.to_string(),
                Style::default().fg(theme::PRIMARY),
            ))
        })
        .collect();
    let para = Paragraph::new(lines).alignment(Alignment::Center);
    f.render_widget(para, area);
}

/// Variant with the central cube-face rows tinted pink — used on
/// `/clear` to reinforce the fresh-session visual. The middle rows
/// (3..=5, 0-indexed) map to the core face and pick up the accent.
pub fn draw_splash_with_core_accent(f: &mut Frame<'_>, area: Rect) {
    let lines: Vec<Line<'_>> = MASCOT
        .lines()
        .enumerate()
        .map(|(idx, row)| {
            let color = if (3..=5).contains(&idx) {
                theme::ERROR
            } else {
                theme::PRIMARY
            };
            Line::from(Span::styled(row.to_string(), Style::default().fg(color)))
        })
        .collect();
    let para = Paragraph::new(lines).alignment(Alignment::Center);
    f.render_widget(para, area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mascot_dimensions_match_constants() {
        let rows: Vec<&str> = MASCOT.lines().collect();
        assert_eq!(rows.len(), MASCOT_ROWS as usize);
        for (i, row) in rows.iter().enumerate() {
            let col_count = row.chars().count();
            assert_eq!(
                col_count, MASCOT_COLS as usize,
                "row {i} has {col_count} columns, expected {MASCOT_COLS}"
            );
        }
    }

    #[test]
    fn mascot_uses_braille_only() {
        for ch in MASCOT.chars() {
            let in_braille = (0x2800..=0x28FF).contains(&(ch as u32));
            let is_newline = ch == '\n';
            assert!(
                in_braille || is_newline,
                "unexpected non-Braille char: {ch:?}"
            );
        }
    }
}
