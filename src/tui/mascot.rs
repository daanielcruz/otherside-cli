

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use super::render::theme;

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

pub const TAGLINE: &str = "past the event horizon · where even returns escape";

pub const MASCOT_COLS: u16 = 70;
pub const MASCOT_ROWS: u16 = 21;

pub fn mascot_rows() -> Vec<&'static str> {
    MASCOT.lines().filter(|l| !l.is_empty()).collect()
}

pub fn padded_rows() -> Vec<String> {
    let rows = mascot_rows();
    let max = rows.iter().map(|r| r.chars().count()).max().unwrap_or(0);
    rows.into_iter()
        .map(|r| {
            let pad = max.saturating_sub(r.chars().count());
            let mut s = r.to_string();
            s.extend(std::iter::repeat(' ').take(pad));
            s
        })
        .collect()
}

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

    draw_mascot_block(f, slots[0]);
    draw_tagline(f, slots[2]);
    draw_name_and_version(f, slots[4]);
    draw_cwd(f, slots[6]);
}

fn draw_mascot_block(f: &mut Frame<'_>, area: Rect) {
    let lines: Vec<Line<'_>> = padded_rows()
        .into_iter()
        .map(|row| Line::from(Span::styled(row, Style::default().fg(theme::PRIMARY))))
        .collect();
    let para = Paragraph::new(lines).alignment(Alignment::Center);
    f.render_widget(para, area);
}

fn draw_name_and_version(f: &mut Frame<'_>, area: Rect) {

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
    let rows = padded_rows();
    let total = rows.len();
    let band_start = total / 3;
    let band_end = total.saturating_sub(total / 3);
    let lines: Vec<Line<'_>> = rows
        .into_iter()
        .enumerate()
        .map(|(idx, row)| {
            // 2026-04-24 directive: collapse amber → primary across the UI.
            // Mascot's mid-band now shares the primary hue instead of amber.
            let _ = band_start;
            let _ = band_end;
            let _ = idx;
            let color = theme::PRIMARY;
            Line::from(Span::styled(row, Style::default().fg(color)))
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

}
