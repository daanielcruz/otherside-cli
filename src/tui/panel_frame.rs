use std::borrow::Cow;

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use crate::tui::render::theme;

// Panel chrome accent (top rule, search bar border, active tab chip bg,
// nav chevron). User directive 2026-04-23: unify every accent on
// `theme::PRIMARY` (teal `rgb(62,160,195)` — see
// src/tui/render.rs:23). The earlier SUGGESTION (blue-purple) accent is
// retired for panel chrome; see `docs/ui-panels/chrome.md` §"Tab row FSM"
// and §"Headline padding".

const FOOTER_SEP: &str = " \u{00B7} ";

// U+26B2 SAGITTARIUS-like magnifier glyph used as the search prefix.
// ASCII fallback reference only — rendered as Unicode at runtime.
const SEARCH_GLYPH: &str = "\u{26B2}";

// U+276F HEAVY RIGHT-POINTING ANGLE QUOTATION MARK ORNAMENT. Single
// canonical chevron used by every selection row — see
// `docs/ui-panels/chrome.md` §"Selection chevron system". Any other
// glyph (▶, ▸, ►, >) is a regression.
pub const CHEVRON: &str = "\u{276F}";

/// One tab chip label. Kept minimal — panels assemble their own list
/// per render.
#[derive(Debug, Clone, Copy)]
pub struct TabSpec<'a> {
    pub label: &'a str,
}

/// Search-bar state as the panel chrome sees it.
///
/// `placeholder` renders when `query` is empty (dim). When `focused` is
/// true the border uses the panel accent and a cursor is shown inside the
/// box at `cursor_pos` (byte offset into `query`); otherwise the border
/// stays accented if text exists, plain otherwise, and no cursor.
#[derive(Debug, Clone, Copy)]
pub struct SearchSpec<'a> {
    pub query: &'a str,
    pub placeholder: &'a str,
    pub focused: bool,
    pub cursor_pos: usize,
}

/// Shared outer shell for slash-panels and footer-triggered panels.
///
/// Layout slots (top → bottom):
///   1. top rule (always)
///   2. headline padding (always — one blank row after the rule)
///   3. optional breadcrumb title
///   4. optional tab row
///   5. optional search bar (bordered)
///   6. body
///   7. optional pagination hint
///   8. footer byline
pub struct PanelFrame<'a> {
    pub title: Option<&'a str>,
    pub tabs: Option<&'a [TabSpec<'a>]>,
    pub active_tab: usize,
    pub tabs_focused: bool,
    pub search: Option<SearchSpec<'a>>,
    pub body: Vec<Line<'a>>,
    pub footer_hints: &'a [(&'a str, &'a str)],
    pub pagination_hint: Option<&'a str>,
}

impl<'a> PanelFrame<'a> {
    pub fn render(self, f: &mut Frame<'_>, area: Rect) {
        if area.width == 0 || area.height == 0 {
            return;
        }

        let mut constraints: Vec<Constraint> = Vec::with_capacity(8);
        // 1. top rule (1 row)
        constraints.push(Constraint::Length(1));
        // 2. headline padding (1 blank row — non-optional, see chrome.md).
        constraints.push(Constraint::Length(1));
        // 3. title
        if self.title.is_some() {
            constraints.push(Constraint::Length(1));
        }
        // 4. tab row
        if self.tabs.is_some() {
            constraints.push(Constraint::Length(1));
        }
        // 5. search (3 rows: border + inner + border)
        if self.search.is_some() {
            constraints.push(Constraint::Length(3));
        }
        // 6. body (fills remaining)
        constraints.push(Constraint::Min(0));
        // 7. pagination hint
        if self.pagination_hint.is_some() {
            constraints.push(Constraint::Length(1));
        }
        // 8. footer
        if !self.footer_hints.is_empty() {
            constraints.push(Constraint::Length(1));
        }

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints(constraints)
            .split(area);

        let mut idx = 0;

        // 1. top rule
        draw_top_rule(f, chunks[idx]);
        idx += 1;

        // 2. headline padding — intentionally left blank.
        idx += 1;

        // 3. title
        if let Some(title) = self.title {
            draw_title(f, chunks[idx], title);
            idx += 1;
        }

        // 4. tab row
        if let Some(tabs) = self.tabs {
            draw_tab_row(f, chunks[idx], tabs, self.active_tab, self.tabs_focused);
            idx += 1;
        }

        // 5. search bar
        if let Some(search) = self.search {
            draw_search_bar(f, chunks[idx], &search);
            idx += 1;
        }

        // 6. body
        draw_body(f, chunks[idx], self.body);
        idx += 1;

        // 7. pagination hint
        if let Some(hint) = self.pagination_hint {
            draw_pagination_hint(f, chunks[idx], hint);
            idx += 1;
        }

        // 8. footer
        if !self.footer_hints.is_empty() {
            draw_footer(f, chunks[idx], self.footer_hints);
        }
    }
}

fn draw_top_rule(f: &mut Frame<'_>, area: Rect) {
    if area.width == 0 {
        return;
    }
    let rule: String = "\u{2500}".repeat(area.width as usize);
    let para = Paragraph::new(Line::from(Span::styled(
        rule,
        Style::default().fg(theme::PRIMARY),
    )));
    f.render_widget(para, area);
}

fn draw_title(f: &mut Frame<'_>, area: Rect, title: &str) {
    let para = Paragraph::new(Line::from(Span::styled(
        title.to_string(),
        Style::default()
            .fg(theme::TEXT)
            .add_modifier(Modifier::BOLD),
    )));
    f.render_widget(para, area);
}

fn draw_tab_row(
    f: &mut Frame<'_>,
    area: Rect,
    tabs: &[TabSpec<'_>],
    active_tab: usize,
    tabs_focused: bool,
) {
    let mut spans: Vec<Span<'static>> = Vec::with_capacity(tabs.len() * 2);
    for (i, tab) in tabs.iter().enumerate() {
        if i > 0 {
            spans.push(Span::raw("  "));
        }
        spans.push(chip_span(tab.label, i == active_tab, tabs_focused));
    }
    let para = Paragraph::new(Line::from(spans));
    f.render_widget(para, area);
}

/// Active tab chip paint per chrome.md §"Tab row FSM": identical across
/// row focus states — `theme::PRIMARY` bg + white fg + bold. The
/// `tabs_focused` parameter is kept on the signature for future wiring
/// of the `❯` row-focus nav prefix (chrome.md §"Selection chevron
/// system") but does not alter the chip paint in Phase 1.
fn chip_span(label: &str, active: bool, tabs_focused: bool) -> Span<'static> {
    let _ = tabs_focused;
    let body = format!(" {label} ");
    let style = match (active, tabs_focused) {
        (false, _) => Style::default().fg(theme::MUTED),
        (true, _) => Style::default()
            .fg(Color::White)
            .bg(theme::PRIMARY)
            .add_modifier(Modifier::BOLD),
    };
    Span::styled(body, style)
}

/// Body row with dual-chevron prefix — see chrome.md
/// §"Selection chevron system".
///
/// - `nav_cursor`: keyboard cursor is currently on this row → paint
///   `❯` in `theme::PRIMARY`.
/// - `selected`: this row is the persistently-committed selection →
///   paint `❯` in `theme::SUCCESS` (Phase 1 default).
/// - Both true → `theme::SUCCESS` + bold to signal nav co-location
///   without swapping the commit color.
/// - Neither → two spaces so label columns stay aligned.
pub fn body_row<'a>(
    label: impl Into<Cow<'a, str>>,
    nav_cursor: bool,
    selected: bool,
) -> Line<'a> {
    let prefix_style = match (nav_cursor, selected) {
        (false, false) => Style::default(),
        (true, false) => Style::default().fg(theme::PRIMARY),
        (false, true) => Style::default().fg(theme::SUCCESS),
        (true, true) => Style::default()
            .fg(theme::SUCCESS)
            .add_modifier(Modifier::BOLD),
    };
    let prefix = if nav_cursor || selected {
        format!("{CHEVRON} ")
    } else {
        "  ".to_string()
    };
    Line::from(vec![
        Span::styled(prefix, prefix_style),
        Span::raw(label.into().into_owned()),
    ])
}

fn draw_search_bar(f: &mut Frame<'_>, area: Rect, spec: &SearchSpec<'_>) {
    let border_color = if spec.focused || !spec.query.is_empty() {
        theme::PRIMARY
    } else {
        theme::MUTED
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color));
    let inner = block.inner(area);
    f.render_widget(block, area);

    if inner.width == 0 || inner.height == 0 {
        return;
    }

    // Prefix glyph + space, then query (or dim placeholder).
    let mut spans: Vec<Span<'static>> = Vec::with_capacity(3);
    spans.push(Span::styled(
        format!("{SEARCH_GLYPH} "),
        Style::default().fg(border_color),
    ));

    if spec.query.is_empty() {
        spans.push(Span::styled(
            spec.placeholder.to_string(),
            Style::default()
                .fg(theme::MUTED)
                .add_modifier(Modifier::DIM),
        ));
    } else {
        spans.push(Span::styled(
            spec.query.to_string(),
            Style::default().fg(theme::TEXT),
        ));
    }

    let para = Paragraph::new(Line::from(spans));
    f.render_widget(para, inner);

    // Cursor: block glyph painted at the query offset when focused. We
    // clamp to inner area so it never escapes the bordered box.
    if spec.focused {
        let prefix_cols: u16 = (SEARCH_GLYPH.chars().count() + 1) as u16;
        let query_cols: u16 = spec
            .query
            .get(..spec.cursor_pos.min(spec.query.len()))
            .unwrap_or("")
            .chars()
            .count() as u16;
        let cursor_x = inner.x.saturating_add(prefix_cols).saturating_add(query_cols);
        if cursor_x < inner.x + inner.width {
            let cursor_area = Rect::new(cursor_x, inner.y, 1, 1);
            let block_glyph = Paragraph::new(Span::styled(
                "\u{2588}",
                Style::default().fg(theme::PRIMARY),
            ));
            f.render_widget(block_glyph, cursor_area);
        }
    }
}

fn draw_body(f: &mut Frame<'_>, area: Rect, body: Vec<Line<'_>>) {
    if body.is_empty() {
        return;
    }
    let para = Paragraph::new(body);
    f.render_widget(para, area);
}

fn draw_pagination_hint(f: &mut Frame<'_>, area: Rect, hint: &str) {
    let para = Paragraph::new(Line::from(Span::styled(
        hint.to_string(),
        Style::default()
            .fg(theme::MUTED)
            .add_modifier(Modifier::DIM),
    )));
    f.render_widget(para, area);
}

fn draw_footer(f: &mut Frame<'_>, area: Rect, hints: &[(&str, &str)]) {
    let mut spans: Vec<Span<'static>> = Vec::with_capacity(hints.len() * 4);
    for (i, (shortcut, action)) in hints.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(
                FOOTER_SEP.to_string(),
                Style::default().fg(theme::MUTED),
            ));
        }
        spans.push(Span::styled(
            format!("{shortcut} "),
            Style::default()
                .fg(theme::MUTED)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            (*action).to_string(),
            Style::default().fg(theme::MUTED),
        ));
    }
    let para = Paragraph::new(Line::from(spans));
    f.render_widget(para, area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use ratatui::Terminal;

    fn buffer_to_string(buf: &Buffer) -> String {
        let (w, h) = (buf.area.width, buf.area.height);
        let mut out = String::new();
        for y in 0..h {
            for x in 0..w {
                out.push_str(buf[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    fn render_to_buffer(frame: PanelFrame<'_>, width: u16, height: u16) -> Buffer {
        let backend = TestBackend::new(width, height);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| {
            let area = Rect::new(0, 0, width, height);
            frame.render(f, area);
        })
        .unwrap();
        term.backend().buffer().clone()
    }

    #[test]
    fn renders_empty_frame_smoke() {
        let frame = PanelFrame {
            title: None,
            tabs: None,
            active_tab: 0,
            tabs_focused: false,
            search: None,
            body: Vec::new(),
            footer_hints: &[],
            pagination_hint: None,
        };
        // Smoke: must not panic even with no content.
        let _ = render_to_buffer(frame, 80, 10);
    }

    #[test]
    fn renders_tab_row_when_tabs_given() {
        let tabs = [
            TabSpec { label: "Status" },
            TabSpec { label: "Config" },
            TabSpec { label: "Usage" },
        ];
        let frame = PanelFrame {
            title: None,
            tabs: Some(&tabs),
            active_tab: 1,
            tabs_focused: false,
            search: None,
            body: Vec::new(),
            footer_hints: &[],
            pagination_hint: None,
        };
        let buf = render_to_buffer(frame, 80, 6);
        let text = buffer_to_string(&buf);
        assert!(text.contains("Status"), "missing Status: {text}");
        assert!(text.contains("Config"), "missing Config: {text}");
        assert!(text.contains("Usage"), "missing Usage: {text}");
    }

    #[test]
    fn active_tab_paint_uses_primary_bg_and_white_fg() {
        // Per chrome.md §"Tab row FSM": active chip paints identical
        // regardless of row focus — `theme::PRIMARY` bg + white fg + bold.
        let tabs = [
            TabSpec { label: "A" },
            TabSpec { label: "B" },
        ];
        let mk = |focused: bool| PanelFrame {
            title: None,
            tabs: Some(&tabs),
            active_tab: 0,
            tabs_focused: focused,
            search: None,
            body: Vec::new(),
            footer_hints: &[],
            pagination_hint: None,
        };

        let unfocused = render_to_buffer(mk(false), 20, 4);
        let focused = render_to_buffer(mk(true), 20, 4);

        // Tab row now lives at y=2 (y=0 top rule, y=1 padding, y=2 tabs).
        // Active chip "A" occupies cells around x=0..3 (" A ").
        let probe_x = 1;
        let probe_y = 2;
        let cell_unfocused = unfocused[(probe_x, probe_y)].clone();
        let cell_focused = focused[(probe_x, probe_y)].clone();

        assert_eq!(
            cell_unfocused.bg, Color::Rgb(0x3E, 0xA0, 0xC3),
            "unfocused active chip bg must be theme::PRIMARY: {cell_unfocused:?}"
        );
        assert_eq!(
            cell_focused.bg, Color::Rgb(0x3E, 0xA0, 0xC3),
            "focused active chip bg must be theme::PRIMARY: {cell_focused:?}"
        );
        assert_eq!(
            cell_unfocused.fg, Color::White,
            "unfocused active chip fg must be white: {cell_unfocused:?}"
        );
        assert_eq!(
            cell_focused.fg, Color::White,
            "focused active chip fg must be white: {cell_focused:?}"
        );
        assert_eq!(
            cell_unfocused.bg, cell_focused.bg,
            "active chip bg must be identical across tabs_focused states"
        );
        assert_eq!(
            cell_unfocused.fg, cell_focused.fg,
            "active chip fg must be identical across tabs_focused states"
        );
    }

    #[test]
    fn top_rule_uses_theme_primary() {
        let frame = PanelFrame {
            title: None,
            tabs: None,
            active_tab: 0,
            tabs_focused: false,
            search: None,
            body: Vec::new(),
            footer_hints: &[],
            pagination_hint: None,
        };
        let buf = render_to_buffer(frame, 12, 3);
        // y=0 is the rule row.
        let cell = buf[(3, 0)].clone();
        assert_eq!(
            cell.symbol(),
            "\u{2500}",
            "top row must render ── rule glyph: {cell:?}"
        );
        assert_eq!(
            cell.fg,
            Color::Rgb(0x3E, 0xA0, 0xC3),
            "top rule fg must be theme::PRIMARY: {cell:?}"
        );
    }

    #[test]
    fn search_border_uses_theme_primary_when_focused() {
        let frame = PanelFrame {
            title: None,
            tabs: None,
            active_tab: 0,
            tabs_focused: false,
            search: Some(SearchSpec {
                query: "",
                placeholder: "Search settings\u{2026}",
                focused: true,
                cursor_pos: 0,
            }),
            body: Vec::new(),
            footer_hints: &[],
            pagination_hint: None,
        };
        let buf = render_to_buffer(frame, 40, 8);
        // Layout: y=0 rule, y=1 padding, y=2 search top-border,
        // y=3 search inner, y=4 search bottom-border.
        let border_cell = buf[(0, 2)].clone();
        assert_eq!(
            border_cell.fg,
            Color::Rgb(0x3E, 0xA0, 0xC3),
            "search top-border must be theme::PRIMARY when focused: {border_cell:?}"
        );
    }

    #[test]
    fn layout_has_blank_padding_row_after_top_rule() {
        // Per chrome.md §"Headline padding": y=0 rule, y=1 blank,
        // y=2 first content row (tabs here).
        let tabs = [TabSpec { label: "Alpha" }];
        let frame = PanelFrame {
            title: None,
            tabs: Some(&tabs),
            active_tab: 0,
            tabs_focused: false,
            search: None,
            body: Vec::new(),
            footer_hints: &[],
            pagination_hint: None,
        };
        let buf = render_to_buffer(frame, 20, 5);
        // y=1 must be all spaces (blank padding row).
        let mut row1 = String::new();
        for x in 0..20u16 {
            row1.push_str(buf[(x, 1)].symbol());
        }
        assert_eq!(
            row1.trim(),
            "",
            "y=1 must be blank padding row, got {row1:?}"
        );
        // y=2 must carry the tab row.
        let mut row2 = String::new();
        for x in 0..20u16 {
            row2.push_str(buf[(x, 2)].symbol());
        }
        assert!(
            row2.contains("Alpha"),
            "tab row must render at y=2 after padding: {row2:?}"
        );
    }

    #[test]
    fn body_row_paints_nav_chevron_in_primary() {
        let line = body_row("Settings", true, false);
        let prefix_span = &line.spans[0];
        assert_eq!(prefix_span.content.as_ref(), "\u{276F} ");
        assert_eq!(
            prefix_span.style.fg,
            Some(Color::Rgb(0x3E, 0xA0, 0xC3)),
            "nav chevron must be theme::PRIMARY: {:?}",
            prefix_span.style
        );
        assert!(
            !prefix_span.style.add_modifier.contains(Modifier::BOLD),
            "nav-only chevron must not be bold: {:?}",
            prefix_span.style
        );
    }

    #[test]
    fn body_row_paints_selected_chevron_in_success() {
        let line = body_row("Agents", false, true);
        let prefix_span = &line.spans[0];
        assert_eq!(prefix_span.content.as_ref(), "\u{276F} ");
        assert_eq!(
            prefix_span.style.fg,
            Some(Color::Rgb(78, 186, 101)),
            "selected chevron must be theme::SUCCESS: {:?}",
            prefix_span.style
        );
        assert!(
            !prefix_span.style.add_modifier.contains(Modifier::BOLD),
            "selected-only chevron must not be bold: {:?}",
            prefix_span.style
        );
    }

    #[test]
    fn body_row_paints_both_when_nav_on_selected_row() {
        let line = body_row("Usage", true, true);
        let prefix_span = &line.spans[0];
        assert_eq!(prefix_span.content.as_ref(), "\u{276F} ");
        assert_eq!(
            prefix_span.style.fg,
            Some(Color::Rgb(78, 186, 101)),
            "nav+selected chevron must stay theme::SUCCESS: {:?}",
            prefix_span.style
        );
        assert!(
            prefix_span.style.add_modifier.contains(Modifier::BOLD),
            "nav+selected chevron must add BOLD to signal co-location: {:?}",
            prefix_span.style
        );
    }

    #[test]
    fn body_row_renders_blank_prefix_when_neither() {
        let line = body_row("Quiet row", false, false);
        let prefix_span = &line.spans[0];
        assert_eq!(
            prefix_span.content.as_ref(),
            "  ",
            "idle row must pad with two spaces to align with chevron column"
        );
    }

    #[test]
    fn renders_search_placeholder_when_query_empty() {
        let frame = PanelFrame {
            title: None,
            tabs: None,
            active_tab: 0,
            tabs_focused: false,
            search: Some(SearchSpec {
                query: "",
                placeholder: "Search settings\u{2026}",
                focused: false,
                cursor_pos: 0,
            }),
            body: Vec::new(),
            footer_hints: &[],
            pagination_hint: None,
        };
        let buf = render_to_buffer(frame, 60, 8);
        let text = buffer_to_string(&buf);
        assert!(
            text.contains("Search settings"),
            "placeholder missing: {text}"
        );
    }

    #[test]
    fn renders_search_query_when_typed() {
        let frame = PanelFrame {
            title: None,
            tabs: None,
            active_tab: 0,
            tabs_focused: false,
            search: Some(SearchSpec {
                query: "ddsa",
                placeholder: "Search settings\u{2026}",
                focused: true,
                cursor_pos: 4,
            }),
            body: Vec::new(),
            footer_hints: &[],
            pagination_hint: None,
        };
        let buf = render_to_buffer(frame, 60, 8);
        let text = buffer_to_string(&buf);
        assert!(text.contains("ddsa"), "query missing: {text}");
    }

    #[test]
    fn renders_footer_hints_separated_by_mid_dot() {
        let hints: &[(&str, &str)] = &[
            ("\u{2191}\u{2193}", "navigate"),
            ("Enter", "select"),
            ("Esc", "close"),
        ];
        let frame = PanelFrame {
            title: None,
            tabs: None,
            active_tab: 0,
            tabs_focused: false,
            search: None,
            body: Vec::new(),
            footer_hints: hints,
            pagination_hint: None,
        };
        let buf = render_to_buffer(frame, 80, 4);
        let text = buffer_to_string(&buf);
        // Three hints → two `·` separators.
        let dots = text.matches('\u{00B7}').count();
        assert_eq!(
            dots, 2,
            "expected exactly 2 mid-dot separators between 3 hints; got {dots} in {text:?}"
        );
    }

    #[test]
    fn renders_pagination_hint_at_body_tail() {
        let body: Vec<Line<'static>> = (0..5)
            .map(|i| Line::from(format!("row {i}")))
            .collect();
        let hint = "\u{2193} 8 more below";
        let frame = PanelFrame {
            title: None,
            tabs: None,
            active_tab: 0,
            tabs_focused: false,
            search: None,
            body,
            footer_hints: &[],
            pagination_hint: Some(hint),
        };
        // Height: 1 top rule + 1 padding + 5 body + 1 pagination = 8.
        let buf = render_to_buffer(frame, 40, 8);
        // Pagination hint occupies the last rendered row (y = height-1).
        let last_y = 7;
        let mut last_row = String::new();
        for x in 0..40u16 {
            last_row.push_str(buf[(x, last_y)].symbol());
        }
        assert!(
            last_row.contains("8 more below"),
            "pagination hint not on final row: {last_row:?}"
        );
    }
}
