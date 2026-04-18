//! Splash mascot — the Braille-density corrupted-Rubik's-cube ASCII
//! plus the "otherside" block-art banner and the multiverse tagline.
//! Canonical source is `docs/design/mascot.md` in the outer repo;
//! this constant is the embedded copy. Both mascot and banner render
//! in white for contrast; tagline uses the muted theme color.

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
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

/// Block-art banner spelling "otherside". Rendered in white below
/// the mascot on splash. 7 rows tall.
pub const BANNER: &str = "\
░▒▓██████▓▒░▒▓████████▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓████████▓▒░▒▓███████▓▒░ ░▒▓███████▓▒░▒▓█▓▒░▒▓███████▓▒░░▒▓████████▓▒░
░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░   ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░
░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░   ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░
░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░   ░▒▓████████▓▒░▒▓██████▓▒░ ░▒▓███████▓▒░ ░▒▓██████▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓██████▓▒░
░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░   ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░
░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░   ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░
 ░▒▓██████▓▒░  ░▒▓█▓▒░   ░▒▓█▓▒░░▒▓█▓▒░▒▓████████▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░░▒▓█▓▒░▒▓███████▓▒░░▒▓████████▓▒░";

/// Tagline below the banner. Intentional multiverse / reversed-world
/// framing — the RE reference stays indirect. Alternates kept for
/// future rotation without hunting the git history.
///
/// Rotation set (pick any; edit `TAGLINE` to swap):
/// - "every call has a return — this is where the return speaks first"
/// - "a shell from the side the debugger can't see"
/// - "walks the wire backwards"
/// - "otherside · where the stack unwinds on its own terms"
pub const TAGLINE: &str = "the inverted pass · where shadows hold state";

/// Mascot dimensions.
pub const MASCOT_COLS: u16 = 30;
pub const MASCOT_ROWS: u16 = 15;

/// Banner dimensions. Width derived at runtime (it's wide).
pub const BANNER_ROWS: u16 = 7;

/// Compute the widest banner line in display columns (char count).
pub fn banner_cols() -> u16 {
    BANNER
        .lines()
        .map(|l| l.chars().count() as u16)
        .max()
        .unwrap_or(0)
}

/// Preferred inner width for the splash box (content width, border
/// rendering will add 2 columns on each side).
const BOX_INNER_WIDTH: u16 = 70;

/// Preferred inner height — mascot + gaps + tagline + cwd.
const BOX_INNER_HEIGHT: u16 = 20;

/// Paint the splash — a centered rounded box styled after upstream's
/// welcome card. Inside: the Rubik's-cube mascot stacked over the
/// tagline and the working-directory line.
///
/// Falls back to a single-line legend when the terminal can't fit
/// the box.
pub fn draw_splash(f: &mut Frame<'_>, area: Rect) {
    use ratatui::widgets::{Block, BorderType, Borders};

    let box_w = BOX_INNER_WIDTH.min(area.width.saturating_sub(4));
    let box_h = BOX_INNER_HEIGHT.min(area.height.saturating_sub(2));

    if box_w < MASCOT_COLS + 4 || box_h < MASCOT_ROWS + 4 {
        let line = Line::from(vec![
            Span::styled(
                "otherside",
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  ·  "),
            Span::styled(TAGLINE, Style::default().fg(theme::MUTED)),
        ]);
        f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
        return;
    }

    let top_pad = (area.height.saturating_sub(box_h)) / 3;
    let left_pad = (area.width.saturating_sub(box_w)) / 2;
    let outer = Rect {
        x: area.x + left_pad,
        y: area.y + top_pad,
        width: box_w,
        height: box_h,
    };

    let title = Line::from(vec![
        Span::styled(" otherside ", Style::default().fg(theme::MUTED)),
        Span::styled(
            concat!("v", env!("CARGO_PKG_VERSION")),
            Style::default().fg(theme::SUBTLE),
        ),
        Span::raw(" "),
    ]);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(theme::MUTED))
        .title(title);
    let inner = block.inner(outer);
    f.render_widget(block, outer);

    // Inner layout: top gap · mascot · gap · tagline · gap · cwd.
    let slots = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(MASCOT_ROWS),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Min(0),
        ])
        .split(inner);

    draw_mascot_block(f, slots[1]);
    draw_tagline(f, slots[3]);
    draw_cwd(f, slots[5]);
}

fn draw_mascot_block(f: &mut Frame<'_>, area: Rect) {
    let lines: Vec<Line<'_>> = MASCOT
        .lines()
        .map(|row| {
            Line::from(Span::styled(
                row.to_string(),
                Style::default().fg(theme::TEXT),
            ))
        })
        .collect();
    let para = Paragraph::new(lines).alignment(Alignment::Center);
    f.render_widget(para, area);
}

fn draw_cwd(f: &mut Frame<'_>, area: Rect) {
    let cwd = std::env::current_dir()
        .map(|p| {
            let s = p.to_string_lossy().to_string();
            if let Some(home) = std::env::var_os("HOME") {
                let home = home.to_string_lossy().to_string();
                if s.starts_with(&home) {
                    return format!("~{}", &s[home.len()..]);
                }
            }
            s
        })
        .unwrap_or_default();
    let line = Line::from(Span::styled(cwd, Style::default().fg(theme::SUBTLE)));
    f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
}

#[allow(dead_code)]
fn draw_banner_block(f: &mut Frame<'_>, area: Rect) {
    let lines: Vec<Line<'_>> = BANNER
        .lines()
        .map(|row| {
            Line::from(Span::styled(
                row.to_string(),
                Style::default().fg(theme::TEXT),
            ))
        })
        .collect();
    let para = Paragraph::new(lines).alignment(Alignment::Center);
    f.render_widget(para, area);
}

fn draw_tagline(f: &mut Frame<'_>, area: Rect) {
    let line = Line::from(Span::styled(
        TAGLINE,
        Style::default().fg(theme::MUTED).add_modifier(Modifier::ITALIC),
    ));
    f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
}

/// Variant with the central cube-face rows tinted pink — used on
/// `/clear` to reinforce the fresh-session visual. Banner + tagline
/// render the same as the default splash.
pub fn draw_splash_with_core_accent(f: &mut Frame<'_>, area: Rect) {
    // For the /clear variant we still want the full composition; the
    // pink-core mascot only affects the mascot block itself.
    let can_banner = area.width >= banner_cols();
    let can_mascot = area.height >= MASCOT_ROWS && area.width >= MASCOT_COLS;

    if !can_mascot {
        let line = Line::from(vec![
            Span::styled(
                "otherside",
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  ·  "),
            Span::styled(TAGLINE, Style::default().fg(theme::MUTED)),
        ]);
        f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
        return;
    }

    let top_pad: u16 = 1;
    let gap_after_mascot: u16 = 1;
    let gap_after_banner: u16 = if can_banner { 1 } else { 0 };
    let tagline_h: u16 = 1;

    let mut constraints: Vec<Constraint> = vec![
        Constraint::Length(top_pad),
        Constraint::Length(MASCOT_ROWS),
        Constraint::Length(gap_after_mascot),
    ];
    if can_banner {
        constraints.push(Constraint::Length(BANNER_ROWS));
        constraints.push(Constraint::Length(gap_after_banner));
    }
    constraints.push(Constraint::Length(tagline_h));
    constraints.push(Constraint::Min(0));

    let slots = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);

    let mut idx = 1;
    draw_mascot_with_core_accent(f, slots[idx]);
    idx += 2;

    if can_banner {
        draw_banner_block(f, slots[idx]);
        idx += 2;
    }

    draw_tagline(f, slots[idx]);
}

fn draw_mascot_with_core_accent(f: &mut Frame<'_>, area: Rect) {
    let lines: Vec<Line<'_>> = MASCOT
        .lines()
        .enumerate()
        .map(|(idx, row)| {
            let color = if (3..=5).contains(&idx) {
                theme::ERROR
            } else {
                theme::TEXT
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

    #[test]
    fn banner_is_seven_rows() {
        let rows: Vec<&str> = BANNER.lines().collect();
        assert_eq!(rows.len(), BANNER_ROWS as usize);
    }

    #[test]
    fn banner_cols_matches_widest_line() {
        let widest = BANNER
            .lines()
            .map(|l| l.chars().count() as u16)
            .max()
            .unwrap();
        assert_eq!(banner_cols(), widest);
    }

    #[test]
    fn tagline_hints_at_inversion() {
        let lower = TAGLINE.to_lowercase();
        // Any of these hint-words is enough; the rotation set all carry at
        // least one. Lock the semantic field, not the exact copy.
        let hits = ["invert", "shadow", "return", "unwind", "back", "side"]
            .iter()
            .filter(|w| lower.contains(*w))
            .count();
        assert!(hits >= 1, "tagline lost its multiverse / RE framing: {TAGLINE:?}");
    }
}
