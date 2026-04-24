
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
use super::panel_frame::{PanelFrame, CHEVRON};
use super::render::theme;

pub const WELCOME_TAGLINE: &str = "a shell for the reversed world";

pub const SECTION_HEADING: &str = "▸ Choose a provider to sign in";

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
            Row::Kimi => "Kimi Code",
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
        
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WelcomeOutcome {
    Stay,
    LoginIntent(ProviderId),
    Quit,
}

#[derive(Debug, Clone)]
pub struct OAuthPasteState {
    pub url: String,
    pub input: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OAuthCallbackWaitState {
    pub title: String,
    pub url: String,
    pub manual_url: Option<String>,
    pub port: u16,
    pub spinner_tick: u8,
    pub input: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackKeyOutcome {
    Stay,
    Submit(String),
    Cancel,
    Quit,
}

pub fn handle_callback_key(k: KeyEvent, st: &mut OAuthCallbackWaitState) -> CallbackKeyOutcome {
    if k.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(k.code, KeyCode::Char('c') | KeyCode::Char('C'))
    {
        return CallbackKeyOutcome::Quit;
    }
    match k.code {
        KeyCode::Esc => CallbackKeyOutcome::Cancel,
        KeyCode::Enter => {
            let trimmed = st.input.trim().to_string();
            if trimmed.is_empty() {
                CallbackKeyOutcome::Stay
            } else {
                CallbackKeyOutcome::Submit(trimmed)
            }
        }
        KeyCode::Backspace => {
            st.input.pop();
            st.error = None;
            CallbackKeyOutcome::Stay
        }
        KeyCode::Char(c) => {
            st.input.push(c);
            st.error = None;
            CallbackKeyOutcome::Stay
        }
        _ => CallbackKeyOutcome::Stay,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasteOutcome {
    Stay,
    Submit(String),
    Cancel,
    Quit,
}

pub fn handle_paste_key(k: KeyEvent, st: &mut OAuthPasteState) -> PasteOutcome {
    if k.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(k.code, KeyCode::Char('c') | KeyCode::Char('C'))
    {
        return PasteOutcome::Quit;
    }
    match k.code {
        KeyCode::Esc => PasteOutcome::Cancel,
        KeyCode::Enter => {
            let trimmed = st.input.trim().to_string();
            if trimmed.is_empty() {
                PasteOutcome::Stay
            } else {
                PasteOutcome::Submit(trimmed)
            }
        }
        KeyCode::Backspace => {
            st.input.pop();
            st.error = None;
            PasteOutcome::Stay
        }
        KeyCode::Char(c) => {
            st.input.push(c);
            st.error = None;
            PasteOutcome::Stay
        }
        _ => PasteOutcome::Stay,
    }
}

pub fn handle_key(k: KeyEvent, state: &mut WelcomeState) -> WelcomeOutcome {
    
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
    
    let rows_n = Row::ALL.len() as u16;
    let panel_min: u16 = 1 + 1 + 1 + 1 + rows_n + 1 + 1; 

    let show_mascot =
        area.height >= MASCOT_ROWS + panel_min + 4 && area.width >= MASCOT_COLS + 2;

    let top_h: u16 = if show_mascot {
        MASCOT_ROWS + 1 + 1 + 1 + 1 
    } else {
        1 + 1 + 1 
    };

    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(top_h),
            Constraint::Min(panel_min),
        ])
        .split(area);

    draw_top_region(f, outer[0], show_mascot);
    draw_picker_panel(f, outer[1], state);
}

fn draw_top_region(f: &mut Frame<'_>, area: Rect, show_mascot: bool) {
    let mut constraints: Vec<Constraint> = Vec::with_capacity(5);
    if show_mascot {
        constraints.push(Constraint::Length(MASCOT_ROWS));
        constraints.push(Constraint::Length(1)); 
    }
    constraints.push(Constraint::Length(1)); 
    constraints.push(Constraint::Length(1)); 
    constraints.push(Constraint::Length(1)); 

    let slots = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);

    let mut i = 0usize;
    if show_mascot {
        draw_mascot_block(f, slots[i]);
        i += 2;
    }
    draw_title(f, slots[i]);
    i += 1;
    draw_tagline(f, slots[i]);
}

fn draw_picker_panel(f: &mut Frame<'_>, area: Rect, state: &WelcomeState) {
    let indent = indent_for(area.width);
    let pad = " ".repeat(indent);

    let mut body: Vec<Line<'_>> = Vec::with_capacity(Row::ALL.len() + 1);
    
    body.push(Line::raw(""));
    for (row_idx, row) in Row::ALL.iter().enumerate() {
        body.push(row_line(*row, row_idx == state.cursor, &pad));
    }

    let frame = PanelFrame {
        title: Some(SECTION_HEADING),
        tabs: None,
        active_tab: 0,
        tabs_focused: false,
        search: None,
        body,
        footer_hints: &[
            ("↑↓", "to navigate"),
            ("Enter", "to sign in"),
            ("Ctrl+C", "to quit"),
        ],
        pagination_hint: None,
    };
    frame.render(f, area);
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

fn row_line<'a>(row: Row, selected: bool, pad: &str) -> Line<'a> {
    let marker = if selected { CHEVRON } else { " " };
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

    let label = row.label();
    let pad_after_label = 18usize.saturating_sub(label.chars().count()).max(2);

    Line::from(vec![
        Span::raw(pad.to_string()),
        Span::styled(marker.to_string(), marker_style),
        Span::raw(" "),
        Span::styled(label.to_string(), label_style),
        Span::raw(" ".repeat(pad_after_label)),
        Span::styled(row.hint().to_string(), hint_style),
    ])
}

fn indent_for(width: u16) -> usize {
    let w = width as usize;
    if w >= 80 {
        4
    } else if w >= 40 {
        2
    } else {
        0
    }
}

pub fn draw_oauth_paste(f: &mut Frame<'_>, area: Rect, st: &OAuthPasteState) {
    
    let indent = indent_for(area.width);
    let usable_w = usable_url_width(area.width, indent);
    let url_lines = wrap_url(&st.url, usable_w).len() as u16;
    let error_lines: u16 = if st.error.is_some() { 2 } else { 0 };
    let panel_min: u16 = 4 + 1 + 1 + url_lines + 1 + 1 + 1 + 1 + error_lines;

    let show_mascot =
        area.height >= MASCOT_ROWS + panel_min + 4 && area.width >= MASCOT_COLS + 2;

    let top_h: u16 = if show_mascot {
        MASCOT_ROWS + 1 + 1 + 1 + 1
    } else {
        1 + 1 + 1
    };

    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(top_h),
            Constraint::Min(panel_min),
        ])
        .split(area);

    draw_top_region(f, outer[0], show_mascot);
    draw_oauth_paste_panel(f, outer[1], st);
}

fn draw_oauth_paste_panel(f: &mut Frame<'_>, area: Rect, st: &OAuthPasteState) {
    let indent = indent_for(area.width);
    let pad = " ".repeat(indent);
    let usable_w = usable_url_width(area.width, indent);

    let mut body: Vec<Line<'_>> = Vec::with_capacity(10);

    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled(
            "Open this URL in your browser to authorize otherside:",
            Style::default().fg(theme::TEXT),
        ),
    ]));
    body.push(Line::raw(""));
    for chunk in wrap_url(&st.url, usable_w) {
        body.push(Line::from(vec![
            Span::raw(pad.clone()),
            Span::styled(
                chunk,
                Style::default()
                    .fg(theme::PRIMARY)
                    .add_modifier(Modifier::UNDERLINED),
            ),
        ]));
    }
    body.push(Line::raw(""));
    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled(
            "After authorizing, paste the ",
            Style::default().fg(theme::TEXT),
        ),
        Span::styled(
            "<code>#<state>",
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            " string below:",
            Style::default().fg(theme::TEXT),
        ),
    ]));
    body.push(Line::raw(""));
    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled("> ", Style::default().fg(theme::PRIMARY)),
        Span::styled(st.input.clone(), Style::default().fg(theme::TEXT)),
        Span::styled("\u{2588}", Style::default().fg(theme::PRIMARY)),
    ]));
    if let Some(err) = &st.error {
        body.push(Line::raw(""));
        body.push(Line::from(vec![
            Span::raw(pad.clone()),
            Span::styled(err.clone(), Style::default().fg(theme::ERROR)),
        ]));
    }

    let frame = PanelFrame {
        title: Some("▸ Authorize with Anthropic"),
        tabs: None,
        active_tab: 0,
        tabs_focused: false,
        search: None,
        body,
        footer_hints: &[
            ("Enter", "to submit"),
            ("Esc", "to cancel"),
            ("Ctrl+C", "to quit"),
        ],
        pagination_hint: None,
    };
    frame.render(f, area);
}

pub fn draw_oauth_callback(f: &mut Frame<'_>, area: Rect, st: &OAuthCallbackWaitState) {
    let indent = indent_for(area.width);
    let usable_w = usable_url_width(area.width, indent);
    let url_lines = wrap_url(&st.url, usable_w).len() as u16;
    let error_lines: u16 = if st.error.is_some() { 2 } else { 0 };
    
    let panel_min: u16 =
        4 + 1 + 1 + url_lines + 1 + 1 + 1 + 1 + error_lines;

    let show_mascot =
        area.height >= MASCOT_ROWS + panel_min + 4 && area.width >= MASCOT_COLS + 2;
    let top_h: u16 = if show_mascot {
        MASCOT_ROWS + 1 + 1 + 1 + 1
    } else {
        1 + 1 + 1
    };

    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(top_h),
            Constraint::Min(panel_min),
        ])
        .split(area);

    draw_top_region(f, outer[0], show_mascot);
    draw_oauth_callback_panel(f, outer[1], st);
}

fn draw_oauth_callback_panel(f: &mut Frame<'_>, area: Rect, st: &OAuthCallbackWaitState) {
    let indent = indent_for(area.width);
    let pad = " ".repeat(indent);
    let usable_w = usable_url_width(area.width, indent);

    let mut body: Vec<Line<'_>> = Vec::with_capacity(16);
    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled(
            "Open this URL in your browser to authorize otherside:",
            Style::default().fg(theme::TEXT),
        ),
    ]));
    body.push(Line::raw(""));
    for chunk in wrap_url(&st.url, usable_w) {
        body.push(Line::from(vec![
            Span::raw(pad.clone()),
            Span::styled(
                chunk,
                Style::default()
                    .fg(theme::PRIMARY)
                    .add_modifier(Modifier::UNDERLINED),
            ),
        ]));
    }
    body.push(Line::raw(""));
    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled(
            "Paste the ",
            Style::default().fg(theme::TEXT),
        ),
        Span::styled(
            "`code`",
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            " string here if we can't reach automatically:",
            Style::default().fg(theme::TEXT),
        ),
    ]));
    body.push(Line::raw(""));
    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled("> ", Style::default().fg(theme::PRIMARY)),
        Span::styled(st.input.clone(), Style::default().fg(theme::TEXT)),
        Span::styled("\u{2588}", Style::default().fg(theme::PRIMARY)),
    ]));
    if let Some(err) = &st.error {
        body.push(Line::raw(""));
        body.push(Line::from(vec![
            Span::raw(pad.clone()),
            Span::styled(err.clone(), Style::default().fg(theme::ERROR)),
        ]));
    }

    let frame = PanelFrame {
        title: Some(st.title.as_str()),
        tabs: None,
        active_tab: 0,
        tabs_focused: false,
        search: None,
        body,
        footer_hints: &[
            ("Enter", "to submit"),
            ("Esc", "to cancel"),
            ("Ctrl+C", "to quit"),
        ],
        pagination_hint: None,
    };
    frame.render(f, area);
}

pub fn draw_api_key_paste(f: &mut Frame<'_>, area: Rect, st: &OAuthPasteState) {
    let indent = indent_for(area.width);
    let usable_w = usable_url_width(area.width, indent);
    let url_lines = wrap_url(&st.url, usable_w).len() as u16;
    let error_lines: u16 = if st.error.is_some() { 2 } else { 0 };
    let panel_min: u16 = 4 + 1 + 1 + url_lines + 1 + 1 + 1 + 1 + error_lines;

    let show_mascot =
        area.height >= MASCOT_ROWS + panel_min + 4 && area.width >= MASCOT_COLS + 2;
    let top_h: u16 = if show_mascot {
        MASCOT_ROWS + 1 + 1 + 1 + 1
    } else {
        1 + 1 + 1
    };

    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(top_h), Constraint::Min(panel_min)])
        .split(area);

    draw_top_region(f, outer[0], show_mascot);
    draw_api_key_panel(f, outer[1], st);
}

fn draw_api_key_panel(f: &mut Frame<'_>, area: Rect, st: &OAuthPasteState) {
    let indent = indent_for(area.width);
    let pad = " ".repeat(indent);
    let usable_w = usable_url_width(area.width, indent);

    let mut body: Vec<Line<'_>> = Vec::with_capacity(10);
    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled(
            "Create or copy a Kimi API key from:",
            Style::default().fg(theme::TEXT),
        ),
    ]));
    body.push(Line::raw(""));
    for chunk in wrap_url(&st.url, usable_w) {
        body.push(Line::from(vec![
            Span::raw(pad.clone()),
            Span::styled(
                chunk,
                Style::default()
                    .fg(theme::PRIMARY)
                    .add_modifier(Modifier::UNDERLINED),
            ),
        ]));
    }
    body.push(Line::raw(""));
    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled(
            "Paste your API key below:",
            Style::default().fg(theme::TEXT),
        ),
    ]));
    body.push(Line::raw(""));
    body.push(Line::from(vec![
        Span::raw(pad.clone()),
        Span::styled("> ", Style::default().fg(theme::PRIMARY)),
        Span::styled(st.input.clone(), Style::default().fg(theme::TEXT)),
        Span::styled("\u{2588}", Style::default().fg(theme::PRIMARY)),
    ]));
    if let Some(err) = &st.error {
        body.push(Line::raw(""));
        body.push(Line::from(vec![
            Span::raw(pad.clone()),
            Span::styled(err.clone(), Style::default().fg(theme::ERROR)),
        ]));
    }

    let frame = PanelFrame {
        title: Some("\u{25B8} Sign in with Kimi"),
        tabs: None,
        active_tab: 0,
        tabs_focused: false,
        search: None,
        body,
        footer_hints: &[
            ("Enter", "to submit"),
            ("Esc", "to cancel"),
            ("Ctrl+C", "to quit"),
        ],
        pagination_hint: None,
    };
    frame.render(f, area);
}

fn usable_url_width(area_w: u16, indent: usize) -> usize {
    (area_w as usize)
        .saturating_sub(indent + 1)
        .max(20)
}

fn wrap_url(url: &str, w: usize) -> Vec<String> {
    if w == 0 || url.is_empty() {
        return vec![url.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut count = 0usize;
    for ch in url.chars() {
        buf.push(ch);
        count += 1;
        if count >= w {
            out.push(std::mem::take(&mut buf));
            count = 0;
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

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

        handle_key(key(KeyCode::Down), &mut state);
        let out = handle_key(key(KeyCode::Enter), &mut state);
        assert_eq!(out, WelcomeOutcome::LoginIntent(ProviderId::Codex));
    }

    #[test]
    fn enter_on_disabled_row_is_noop() {
        
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

        assert!(
            buffer_contains(buf, "otherside cli"),
            "welcome frame must contain title 'otherside cli'"
        );
        assert!(
            buffer_contains(buf, concat!("v", env!("CARGO_PKG_VERSION"))),
            "welcome frame must contain the current version"
        );

        assert!(
            buffer_contains(buf, WELCOME_TAGLINE),
            "welcome frame must contain welcome tagline: {WELCOME_TAGLINE:?}"
        );

        assert!(
            buffer_contains(buf, "Choose a provider to sign in"),
            "welcome frame must contain section heading"
        );

        for row in Row::ALL {
            assert!(
                buffer_contains(buf, row.label()),
                "welcome frame must contain row label {:?}",
                row.label()
            );
        }

        for row in Row::ALL {
            assert!(
                buffer_contains(buf, row.hint()),
                "welcome frame must contain hint {:?}",
                row.hint()
            );
        }

        assert!(
            buffer_contains(buf, "navigate"),
            "welcome frame must contain footer byline"
        );
        assert!(
            buffer_contains(buf, "Ctrl+C to quit"),
            "welcome frame must contain Ctrl+C hint in footer"
        );

        assert!(
            buffer_contains(buf, "\u{276F}"),
            "welcome frame must render the chevron selection marker"
        );
    }
}
