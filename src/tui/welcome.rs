//! Welcome screen — zero-cred floor, Phase 1 (UI-only).
//!
//! Renders a full-screen boot UX when no provider has stored credentials.
//! Owns its own layout — it is NOT a slash panel, so `panel_frame.rs` is
//! intentionally unused here. Re-uses `mascot::padded_rows()` for the art
//! without duplicating or mutating the constants.
//!
//! Phase 2 (not yet wired): replace the `LoginIntent` stub in the call site
//! with `state::broker::login(provider).await` and transition to chat on
//! success. See `docs/ui-panels/welcome-screen.md`.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::config::providers::ProviderId;

use super::mascot::{padded_rows, MASCOT_COLS, MASCOT_ROWS};
use super::render::theme;

/// Tagline specific to the welcome screen. Distinct from
/// `mascot::TAGLINE` (which is the boot-splash black-hole framing) — the
/// welcome screen's tagline is the first-run "what is this thing" one-liner.
pub const WELCOME_TAGLINE: &str = "a shell for the reversed world";

pub const SECTION_HEADING: &str = "▸ Choose a provider to sign in";
pub const FOOTER_BYLINE: &str = "↑↓ navigate · Enter to sign in · Ctrl+C to quit";

/// One row in the provider picker. Order matches the wireframe in
/// `docs/ui-panels/welcome-screen.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
    Anthropic,
    Codex,
    Gemini,
    Kimi,
    Custom,
}

impl Row {
    pub const ALL: &'static [Row] = &[
        Row::Anthropic,
        Row::Codex,
        Row::Gemini,
        Row::Kimi,
        Row::Custom,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Row::Anthropic => "Anthropic",
            Row::Codex => "Codex",
            Row::Gemini => "Gemini",
            Row::Kimi => "Kimi",
            Row::Custom => "Custom",
        }
    }

    pub fn hint(self) -> &'static str {
        match self {
            Row::Anthropic => "OAuth — claude.ai",
            Row::Codex => "OAuth — chatgpt.com",
            Row::Gemini => "OAuth — google (not yet available)",
            Row::Kimi => "API Key — moonshot.cn",
            Row::Custom => "OpenAI-compatible (base URL + key)",
        }
    }

    /// Disabled rows render dim and are skipped by arrow-nav; Enter on a
    /// disabled row is a no-op.
    pub fn enabled(self) -> bool {
        !matches!(self, Row::Gemini | Row::Custom)
    }

    pub fn provider(self) -> ProviderId {
        match self {
            Row::Anthropic => ProviderId::ClaudeCode,
            Row::Codex => ProviderId::Codex,
            Row::Gemini => ProviderId::GeminiCli,
            Row::Kimi => ProviderId::Kimi,
            Row::Custom => ProviderId::OpenAiCustom,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WelcomeState {
    /// Index into `Row::ALL`. Always points at an enabled row — the
    /// constructor lands on the first enabled row and arrow-nav skips
    /// disabled rows. Tests may set this directly to exercise the
    /// disabled-row Enter path.
    pub cursor: usize,
}

impl Default for WelcomeState {
    fn default() -> Self {
        let cursor = Row::ALL
            .iter()
            .position(|r| r.enabled())
            .unwrap_or(0);
        WelcomeState { cursor }
    }
}

impl WelcomeState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn current_row(&self) -> Row {
        Row::ALL[self.cursor.min(Row::ALL.len() - 1)]
    }

    fn step(&mut self, direction: i32) {
        let n = Row::ALL.len() as i32;
        let mut idx = self.cursor as i32;
        for _ in 0..n {
            idx = (idx + direction).rem_euclid(n);
            if Row::ALL[idx as usize].enabled() {
                self.cursor = idx as usize;
                return;
            }
        }
        // All disabled — pathological; leave cursor alone.
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WelcomeOutcome {
    Stay,
    LoginIntent(ProviderId),
    Quit,
}

pub fn handle_key(k: KeyEvent, state: &mut WelcomeState) -> WelcomeOutcome {
    // Ctrl+C exits the process regardless of current row. Spec says it's
    // the only way out of the welcome floor.
    if k.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(k.code, KeyCode::Char('c') | KeyCode::Char('C'))
    {
        return WelcomeOutcome::Quit;
    }

    match k.code {
        KeyCode::Up => {
            state.step(-1);
            WelcomeOutcome::Stay
        }
        KeyCode::Down => {
            state.step(1);
            WelcomeOutcome::Stay
        }
        KeyCode::Enter => {
            let row = state.current_row();
            if row.enabled() {
                WelcomeOutcome::LoginIntent(row.provider())
            } else {
                WelcomeOutcome::Stay
            }
        }
        _ => WelcomeOutcome::Stay,
    }
}

pub fn draw(f: &mut Frame<'_>, area: Rect, state: &WelcomeState) {
    // Vertical layout: mascot block (if it fits), title, tagline, gap,
    // section heading, gap, 5 picker rows, gap, footer. On very small
    // terminals (rows < 20) drop the mascot to conserve vertical space
    // per spec § "On small terminals".
    let show_mascot = area.height >= MASCOT_ROWS + 10 && area.width >= MASCOT_COLS + 2;

    let picker_rows = Row::ALL.len() as u16;
    // 1 heading + 1 gap + 5 rows + 1 gap + 1 footer = 9 required below the header block.
    let below_header: u16 = 1 + 1 + picker_rows + 1 + 1;
    let header_block: u16 = if show_mascot {
        MASCOT_ROWS + 1 + 1 + 1 + 1 // mascot + gap + title + tagline + gap
    } else {
        1 + 1 + 1 // title + tagline + gap
    };

    let content_h = header_block + below_header;
    let top_pad = area.height.saturating_sub(content_h) / 3;
    let padded = Rect {
        x: area.x,
        y: area.y + top_pad,
        width: area.width,
        height: area.height.saturating_sub(top_pad),
    };

    let mut constraints: Vec<Constraint> = Vec::new();
    if show_mascot {
        constraints.push(Constraint::Length(MASCOT_ROWS));
        constraints.push(Constraint::Length(1)); // gap
    }
    constraints.push(Constraint::Length(1)); // title
    constraints.push(Constraint::Length(1)); // tagline
    constraints.push(Constraint::Length(1)); // gap
    constraints.push(Constraint::Length(1)); // section heading
    constraints.push(Constraint::Length(1)); // gap
    for _ in 0..picker_rows {
        constraints.push(Constraint::Length(1));
    }
    constraints.push(Constraint::Length(1)); // gap
    constraints.push(Constraint::Length(1)); // footer
    constraints.push(Constraint::Min(0));

    let slots = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(padded);

    let mut i = 0usize;
    if show_mascot {
        draw_mascot_block(f, slots[i]);
        i += 2; // mascot + gap
    }
    draw_title(f, slots[i]);
    i += 1;
    draw_tagline(f, slots[i]);
    i += 2; // tagline + gap

    draw_section_heading(f, slots[i]);
    i += 2; // heading + gap

    for (row_idx, row) in Row::ALL.iter().enumerate() {
        draw_row(f, slots[i], *row, row_idx == state.cursor);
        i += 1;
    }
    i += 1; // gap
    draw_footer(f, slots[i]);
}

fn draw_mascot_block(f: &mut Frame<'_>, area: Rect) {
    let lines: Vec<Line<'_>> = padded_rows()
        .into_iter()
        .map(|row| Line::from(Span::styled(row, Style::default().fg(theme::PRIMARY))))
        .collect();
    let para = Paragraph::new(lines).alignment(Alignment::Center);
    f.render_widget(para, area);
}

fn draw_title(f: &mut Frame<'_>, area: Rect) {
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

fn draw_tagline(f: &mut Frame<'_>, area: Rect) {
    let line = Line::from(Span::styled(
        WELCOME_TAGLINE,
        Style::default()
            .fg(theme::MUTED)
            .add_modifier(Modifier::ITALIC),
    ));
    f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
}

fn draw_section_heading(f: &mut Frame<'_>, area: Rect) {
    // Left-indent the heading so it aligns with the picker rows rather
    // than centering. Matches the wireframe's left-anchored column.
    let indent = indent_for(area.width);
    let line = Line::from(vec![
        Span::raw(" ".repeat(indent)),
        Span::styled(
            SECTION_HEADING,
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn draw_row(f: &mut Frame<'_>, area: Rect, row: Row, selected: bool) {
    let indent = indent_for(area.width);
    let marker = if selected { "●" } else { " " };
    let marker_style = if selected {
        Style::default().fg(theme::PRIMARY)
    } else {
        Style::default().fg(theme::SUBTLE)
    };

    let label_style = if row.enabled() {
        if selected {
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::TEXT)
        }
    } else {
        Style::default()
            .fg(theme::SUBTLE)
            .add_modifier(Modifier::DIM)
    };
    let hint_style = if row.enabled() {
        Style::default().fg(theme::MUTED)
    } else {
        Style::default()
            .fg(theme::SUBTLE)
            .add_modifier(Modifier::DIM)
    };

    // Align hints at col 18 relative to the label start (per spec
    // "Padding: fixed column anchor").
    let label = row.label();
    let pad_after_label = 18usize.saturating_sub(label.chars().count()).max(2);

    let line = Line::from(vec![
        Span::raw(" ".repeat(indent)),
        Span::styled(marker, marker_style),
        Span::raw(" "),
        Span::styled(label, label_style),
        Span::raw(" ".repeat(pad_after_label)),
        Span::styled(row.hint(), hint_style),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn draw_footer(f: &mut Frame<'_>, area: Rect) {
    let line = Line::from(Span::styled(
        FOOTER_BYLINE,
        Style::default().fg(theme::SUBTLE),
    ));
    f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
}

/// Column indent for left-anchored rows. Keeps the picker off the frame
/// edge without computing a centered column (the wireframe shows rows
/// starting a few cells in from the left).
fn indent_for(width: u16) -> usize {
    // Target ~column 4 on ≥80-wide terminals, scale down on narrower ones.
    let w = width as usize;
    if w >= 80 {
        4
    } else if w >= 40 {
        2
    } else {
        0
    }
}

// Phase 2: wire broker::login here — on Enter for enabled row, replace
// the call-site `eprintln!` stub with `state::broker::login(provider).await`
// and transition directly into chat on success.

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use ratatui::Terminal;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn buffer_contains(buf: &Buffer, needle: &str) -> bool {
        for y in 0..buf.area.height {
            let mut line = String::new();
            for x in 0..buf.area.width {
                line.push_str(buf[(x, y)].symbol());
            }
            if line.contains(needle) {
                return true;
            }
        }
        false
    }

    #[test]
    fn cursor_starts_on_first_enabled_row() {
        let state = WelcomeState::new();
        assert_eq!(
            state.current_row(),
            Row::Anthropic,
            "first enabled row must be Anthropic per wireframe"
        );
    }

    #[test]
    fn arrow_nav_skips_disabled_rows() {
        // Forward: Anthropic -> Codex -> (skip Gemini) -> Kimi -> (skip Custom) -> Anthropic.
        let mut state = WelcomeState::new();
        assert_eq!(state.current_row(), Row::Anthropic);

        assert_eq!(handle_key(key(KeyCode::Down), &mut state), WelcomeOutcome::Stay);
        assert_eq!(state.current_row(), Row::Codex);

        assert_eq!(handle_key(key(KeyCode::Down), &mut state), WelcomeOutcome::Stay);
        assert_eq!(
            state.current_row(),
            Row::Kimi,
            "Down from Codex must skip disabled Gemini and land on Kimi"
        );

        assert_eq!(handle_key(key(KeyCode::Down), &mut state), WelcomeOutcome::Stay);
        assert_eq!(
            state.current_row(),
            Row::Anthropic,
            "Down from Kimi must skip disabled Custom and wrap to Anthropic"
        );

        // Backward wrap: Anthropic -> (skip Custom) -> Kimi.
        assert_eq!(handle_key(key(KeyCode::Up), &mut state), WelcomeOutcome::Stay);
        assert_eq!(
            state.current_row(),
            Row::Kimi,
            "Up from Anthropic must skip disabled Custom and wrap to Kimi"
        );
    }

    #[test]
    fn enter_on_enabled_row_emits_loginintent() {
        let mut state = WelcomeState::new();
        let out = handle_key(key(KeyCode::Enter), &mut state);
        assert_eq!(out, WelcomeOutcome::LoginIntent(ProviderId::ClaudeCode));

        // Move to Codex and assert the correct provider is emitted.
        handle_key(key(KeyCode::Down), &mut state);
        let out = handle_key(key(KeyCode::Enter), &mut state);
        assert_eq!(out, WelcomeOutcome::LoginIntent(ProviderId::Codex));
    }

    #[test]
    fn enter_on_disabled_row_is_noop() {
        // Arrow-nav can't land on a disabled row, so force cursor directly.
        let gemini_idx = Row::ALL.iter().position(|r| *r == Row::Gemini).unwrap();
        let mut state = WelcomeState { cursor: gemini_idx };
        assert_eq!(state.current_row(), Row::Gemini);
        let out = handle_key(key(KeyCode::Enter), &mut state);
        assert_eq!(out, WelcomeOutcome::Stay);
        assert_eq!(state.current_row(), Row::Gemini, "Enter must not move cursor");

        let custom_idx = Row::ALL.iter().position(|r| *r == Row::Custom).unwrap();
        let mut state = WelcomeState { cursor: custom_idx };
        let out = handle_key(key(KeyCode::Enter), &mut state);
        assert_eq!(out, WelcomeOutcome::Stay);
    }

    #[test]
    fn ctrl_c_emits_quit() {
        let mut state = WelcomeState::new();
        let evt = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(handle_key(evt, &mut state), WelcomeOutcome::Quit);
    }

    #[test]
    #[ignore = "dev-only: prints frame to stdout for eyeballing — run with --ignored --nocapture"]
    fn _dump_frame() {
        let backend = TestBackend::new(100, 40);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let state = WelcomeState::new();
        terminal
            .draw(|f| draw(f, f.area(), &state))
            .expect("draw");
        let buf = terminal.backend().buffer();
        println!("\n----- welcome frame (100x40, cursor=Anthropic) -----");
        for y in 0..buf.area.height {
            let mut line = String::new();
            for x in 0..buf.area.width {
                line.push_str(buf[(x, y)].symbol());
            }
            println!("|{}|", line.trim_end());
        }
        println!("----- end frame -----");
    }

    #[test]
    fn render_contains_title_tagline_and_all_five_rows() {
        let backend = TestBackend::new(100, 40);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let state = WelcomeState::new();
        terminal
            .draw(|f| draw(f, f.area(), &state))
            .expect("draw");
        let buf = terminal.backend().buffer();

        // Title + version.
        assert!(
            buffer_contains(buf, "otherside cli"),
            "welcome frame must contain title 'otherside cli'"
        );
        assert!(
            buffer_contains(buf, concat!("v", env!("CARGO_PKG_VERSION"))),
            "welcome frame must contain the current version"
        );

        // Welcome tagline (distinct from mascot TAGLINE).
        assert!(
            buffer_contains(buf, WELCOME_TAGLINE),
            "welcome frame must contain welcome tagline: {WELCOME_TAGLINE:?}"
        );

        // Section heading.
        assert!(
            buffer_contains(buf, "Choose a provider to sign in"),
            "welcome frame must contain section heading"
        );

        // All five provider labels.
        for row in Row::ALL {
            assert!(
                buffer_contains(buf, row.label()),
                "welcome frame must contain row label {:?}",
                row.label()
            );
        }

        // All five hints.
        for row in Row::ALL {
            assert!(
                buffer_contains(buf, row.hint()),
                "welcome frame must contain hint {:?}",
                row.hint()
            );
        }

        // Footer byline.
        assert!(
            buffer_contains(buf, "navigate"),
            "welcome frame must contain footer byline"
        );
        assert!(
            buffer_contains(buf, "Ctrl+C to quit"),
            "welcome frame must contain Ctrl+C hint in footer"
        );

        // Selection marker on the current (first enabled) row.
        assert!(
            buffer_contains(buf, "●"),
            "welcome frame must render the selection marker ●"
        );
    }
}
