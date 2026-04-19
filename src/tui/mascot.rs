//! Splash mascot — rendered centered over the streaming area with a
//! tagline, crate name + version, and working-directory line stacked
//! below. No border, no banner — just the mascot composition.
//! Canonical source for the ASCII is `docs/design/mascot.md` in the
//! outer repo; the constant below is the embedded copy.

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
pub const MASCOT: &str = "
                               +++++++++                              
                          +++++==-----=-==++++                        
                        +++-::---:::...:------++                      
                      ++=:--::.:..:::...:-:..--==+++                  
                     ++---::..:==++ ++*=:...:::..-==++ +++            
                   ++=-=-:.-+            *=-..:--:::-=-+++            
                 +++-==:.:+                #=:....:----=====+*##      
                ++=-=-:.=+                  ##+-:..::.....:+==+*#     
              +++-+=-:.=*                    ##*+-..:::...:-=-+*#     
           +++====-:..=##                     #*:.......::-++*##      
         +=---::....-+*##                   +*=..::..::=++*###        
       +=--:::..:..:-+##               ++=-::...::--=+*####           
      ++-=-:.....:...::=++*###**====--:...::---=+*####                
      #*+=-==-..:::::::..........::..:-==++**#######                  
       ###***++==--=---------++******######  #+--++                   
          %%###***####***#########        ##*-.:++                    
               **##**+=:.:=*##          ##+-.:-++                     
                    +++-::...:=+******+-:..:-++                       
                       +++=::..........::-=++                         
                           +++---:----+++*                            
                                +++++                                  
";

/// Tagline below the mascot — black-hole flavored RE pun. Every
/// black hole swallows light; in otherside, the stack collapses the
/// other way and return values escape anyway.
///
/// Rotation set (pick any; edit `TAGLINE` to swap):
/// - "past the event horizon · where even returns escape"
/// - "singularity where the stack unwinds backwards"
/// - "no light escapes — but every return does"
/// - "where the call graph folds into the accretion disk"
pub const TAGLINE: &str = "past the event horizon · where even returns escape";

/// Mascot dimensions — 21 content rows × 70 columns. The literal
/// above starts with a newline for indentation; [`mascot_rows`]
/// strips the empty leading line so consumers see the 21 visual
/// rows only.
pub const MASCOT_COLS: u16 = 70;
pub const MASCOT_ROWS: u16 = 21;

/// Return the visible mascot rows — drops the leading empty line
/// that the raw string literal carries. Renderers and tests both
/// go through this so layout math lines up with what paints.
pub fn mascot_rows() -> Vec<&'static str> {
    MASCOT.lines().filter(|l| !l.is_empty()).collect()
}

/// Paint the splash — mascot centered over the streaming area with
/// tagline, `otherside cli vX.Y.Z`, and the working-directory line
/// stacked below. No border, no banner.
///
/// Falls back to a single-line legend when the terminal is too
/// narrow / short to host the mascot.
pub fn draw_splash(f: &mut Frame<'_>, area: Rect) {
    if area.width < MASCOT_COLS + 2 || area.height < MASCOT_ROWS + 6 {
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

    // Stack (top → bottom): mascot · gap · tagline · gap ·
    // "otherside cli vX.Y.Z" · gap · cwd. Top third of remaining
    // vertical space acts as breathing room so the block rides the
    // upper half of the streaming area.
    let content_h: u16 = MASCOT_ROWS + 1 + 1 + 1 + 1 + 1 + 1;
    let top_pad = area.height.saturating_sub(content_h) / 3;
    let padded = Rect {
        x: area.x,
        y: area.y + top_pad,
        width: area.width,
        height: area.height.saturating_sub(top_pad),
    };
    let slots = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(MASCOT_ROWS), // 0 — mascot
            Constraint::Length(1),           // 1 — gap
            Constraint::Length(1),           // 2 — tagline
            Constraint::Length(1),           // 3 — gap
            Constraint::Length(1),           // 4 — otherside cli vX.Y.Z
            Constraint::Length(1),           // 5 — gap
            Constraint::Length(1),           // 6 — cwd
            Constraint::Min(0),
        ])
        .split(padded);

    draw_mascot_block(f, slots[0]);
    draw_tagline(f, slots[2]);
    draw_name_and_version(f, slots[4]);
    draw_cwd(f, slots[6]);
}

fn draw_mascot_block(f: &mut Frame<'_>, area: Rect) {
    let lines: Vec<Line<'_>> = mascot_rows()
        .into_iter()
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

fn draw_name_and_version(f: &mut Frame<'_>, area: Rect) {
    // Bold crate name + dim version, centered. Sits between tagline
    // and cwd in the splash stack.
    let line = Line::from(vec![
        Span::styled(
            "otherside cli",
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(
            concat!("v", env!("CARGO_PKG_VERSION")),
            Style::default().fg(theme::SUBTLE),
        ),
    ]);
    f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
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

fn draw_tagline(f: &mut Frame<'_>, area: Rect) {
    let line = Line::from(Span::styled(
        TAGLINE,
        Style::default().fg(theme::MUTED).add_modifier(Modifier::ITALIC),
    ));
    f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
}

/// `/clear` variant — same composition as [`draw_splash`] but tints
/// the mascot core rows with the accent color to reinforce the fresh
/// session visual.
pub fn draw_splash_with_core_accent(f: &mut Frame<'_>, area: Rect) {
    if area.width < MASCOT_COLS + 2 || area.height < MASCOT_ROWS + 6 {
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

    let content_h: u16 = MASCOT_ROWS + 1 + 1 + 1 + 1 + 1 + 1;
    let top_pad = area.height.saturating_sub(content_h) / 3;
    let padded = Rect {
        x: area.x,
        y: area.y + top_pad,
        width: area.width,
        height: area.height.saturating_sub(top_pad),
    };
    let slots = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(MASCOT_ROWS),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Min(0),
        ])
        .split(padded);

    draw_mascot_with_core_accent(f, slots[0]);
    draw_tagline(f, slots[2]);
    draw_name_and_version(f, slots[4]);
    draw_cwd(f, slots[6]);
}

fn draw_mascot_with_core_accent(f: &mut Frame<'_>, area: Rect) {
    let rows = mascot_rows();
    let total = rows.len();
    let band_start = total / 3;
    let band_end = total.saturating_sub(total / 3);
    let lines: Vec<Line<'_>> = rows
        .into_iter()
        .enumerate()
        .map(|(idx, row)| {
            // Middle third of the mascot gets the accent tint on
            // /clear — reinforces the fresh-session signal without
            // swapping the whole glyph color.
            let color = if (band_start..band_end).contains(&idx) {
                theme::ACCENT_AMBER
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
    fn mascot_has_content_rows() {
        // The art is user-curated — don't lock column widths here
        // (rows may have uneven trailing whitespace). Just assert
        // that `mascot_rows` strips the leading empty line and
        // exposes at least the declared row count of non-empty
        // rows so the renderer has something to paint.
        let rows = mascot_rows();
        assert!(
            rows.len() >= MASCOT_ROWS as usize,
            "expected at least {MASCOT_ROWS} content rows, got {}",
            rows.len()
        );
        for (i, row) in rows.iter().enumerate() {
            assert!(!row.is_empty(), "row {i} is empty after filter");
        }
    }

    #[test]
    fn tagline_carries_black_hole_framing() {
        let lower = TAGLINE.to_lowercase();
        // Any of these hint-words is enough; the rotation set all
        // carry at least one. Lock the semantic field, not the copy.
        let hits = [
            "horizon",
            "singularity",
            "light",
            "accretion",
            "return",
            "escape",
            "unwind",
        ]
        .iter()
        .filter(|w| lower.contains(*w))
        .count();
        assert!(
            hits >= 1,
            "tagline lost its black-hole framing: {TAGLINE:?}"
        );
    }
}
