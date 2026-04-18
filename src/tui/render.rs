//! Drawing functions for the TUI.
//!
//! ratatui is immediate-mode: we re-render everything on every tick. Layout
//! is a vertical split — a single-line header, a message log that fills the
//! remainder, and a three-line input box. The render layer reads
//! [`crate::tui::state::ConversationState`] but never mutates it; mutations
//! happen in the event loop.
//!
//! # Theme constants
//!
//! All user-tunable colors live in [`theme`] below. The user hasn't
//! finalized the palette yet, so those constants are placeholders — edit
//! them here and every widget picks up the change on the next render.

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::inference::OpenAiChatRole;

use super::state::ConversationState;

/// Visual theme. Placeholder values — user will finalize. Edit these
/// constants (they are the only source of color in the TUI) and the whole
/// interface recolors on the next frame.
pub mod theme {
    use ratatui::style::Color;

    /// Deep violet — primary accent (borders, header background,
    /// assistant role prefix).
    pub const PRIMARY: Color = Color::Rgb(0x51, 0x15, 0x8C);

    /// Hot pink — error / warning color.
    pub const ERROR: Color = Color::Rgb(0xEC, 0x48, 0x99);

    /// Muted gray — ambient helper text (shortcuts hint, `context: --%`).
    pub const MUTED: Color = Color::Rgb(0x6B, 0x72, 0x80);
}

/// Spinner frames for the streaming indicator. Braille dots chosen because
/// they share width (1 cell) across most monospaced fonts.
const SPINNER: &[char] = &['\u{280B}', '\u{2819}', '\u{2839}', '\u{2838}', '\u{283C}', '\u{2834}', '\u{2826}', '\u{2827}', '\u{2807}', '\u{280F}'];

/// Public entry — compose the three regions and hand each a subrect.
pub fn render(
    f: &mut Frame<'_>,
    state: &ConversationState,
    model: &str,
    provider_id: &str,
    spinner_tick: u64,
) {
    let area = f.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // header
            Constraint::Min(3),    // log (flexes)
            Constraint::Length(3), // input box (3 rows w/ border)
        ])
        .split(area);

    draw_header(f, chunks[0], model, provider_id, state.streaming, spinner_tick);
    draw_log(f, chunks[1], state, spinner_tick);
    draw_input(f, chunks[2], state);
}

/// Single-line header: `otherside | <model> | provider: <id>   context: --% used`.
///
/// The context indicator is a deliberate placeholder; token counting comes
/// later with the statusline phase. Keeping the slot reserved avoids
/// layout drift when that feature lands.
fn draw_header(
    f: &mut Frame<'_>,
    area: Rect,
    model: &str,
    provider_id: &str,
    streaming: bool,
    spinner_tick: u64,
) {
    let spin = if streaming {
        let ch = SPINNER[(spinner_tick as usize) % SPINNER.len()];
        format!("  {ch} streaming")
    } else {
        String::new()
    };

    let left = Line::from(vec![
        Span::styled(
            " otherside ",
            Style::default()
                .bg(theme::PRIMARY)
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" | "),
        Span::styled(model.to_string(), Style::default().fg(theme::PRIMARY)),
        Span::raw(" | provider: "),
        Span::styled(provider_id.to_string(), Style::default().fg(theme::PRIMARY)),
        Span::raw("   "),
        Span::styled(
            "context: --% used",
            Style::default().fg(theme::MUTED),
        ),
        Span::styled(spin, Style::default().fg(theme::PRIMARY)),
    ]);
    f.render_widget(Paragraph::new(left), area);
}

/// The scrolling message log. Each finalized message is rendered as a
/// role-prefix line followed by the content; the in-flight assistant
/// buffer gets the same treatment while `streaming` is true.
fn draw_log(f: &mut Frame<'_>, area: Rect, state: &ConversationState, spinner_tick: u64) {
    let mut lines: Vec<Line> = Vec::new();

    for msg in &state.messages {
        lines.extend(render_message(msg.role, &msg.content));
        lines.push(Line::raw(""));
    }

    // In-flight assistant turn — render only if streaming. If no content
    // has arrived yet, show a spinner-dot placeholder so the user knows
    // something IS happening, not that the UI is frozen.
    if state.streaming {
        let body = if state.current_assistant_buffer.is_empty() {
            let ch = SPINNER[(spinner_tick as usize) % SPINNER.len()];
            format!("{ch}")
        } else {
            state.current_assistant_buffer.clone()
        };
        lines.extend(render_message(OpenAiChatRole::Assistant, &body));
        lines.push(Line::raw(""));
    }

    // Error banner — pinned after all messages so it stays visible while
    // the user reads context above.
    if let Some(err) = &state.last_error {
        lines.push(Line::from(Span::styled(
            format!("error: {err}"),
            Style::default().fg(theme::ERROR).add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::raw(""));
    }

    let block = Block::default()
        .borders(Borders::TOP | Borders::BOTTOM)
        .border_style(Style::default().fg(theme::PRIMARY));

    // Scroll offset: ratatui's Paragraph scroll is (y, x) lines from top.
    // We store offset from BOTTOM, so translate: visible_lines is the
    // widget's inner height; total lines minus visible minus user offset.
    let total_lines = lines.len() as u16;
    let inner_h = block.inner(area).height;
    let max_top = total_lines.saturating_sub(inner_h);
    let top = max_top.saturating_sub(state.scroll_offset as u16);

    let para = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false })
        .scroll((top, 0));
    f.render_widget(para, area);
}

/// Produce one-or-more [`Line`]s for a single message. The role prefix is
/// styled per theme; the content is rendered as plain wrapped text with
/// inline line-breaks preserved.
fn render_message(role: OpenAiChatRole, content: &str) -> Vec<Line<'static>> {
    let (label, label_style) = match role {
        OpenAiChatRole::User => (
            "user: ",
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        OpenAiChatRole::Assistant => (
            "assistant: ",
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        OpenAiChatRole::System => (
            "system: ",
            Style::default().fg(theme::MUTED).add_modifier(Modifier::BOLD),
        ),
        OpenAiChatRole::Tool => (
            "tool: ",
            Style::default().fg(theme::MUTED).add_modifier(Modifier::BOLD),
        ),
    };

    // Split the content on newlines so Paragraph's wrap keeps the author's
    // original linebreaks intact; first line is prefixed with the role
    // label, subsequent lines indent to the same column for readability.
    let mut parts = content.split('\n');
    let first = parts.next().unwrap_or("").to_string();
    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(Line::from(vec![
        Span::styled(label, label_style),
        Span::raw(first),
    ]));
    let indent = " ".repeat(label.len());
    for rest in parts {
        lines.push(Line::from(vec![
            Span::raw(indent.clone()),
            Span::raw(rest.to_string()),
        ]));
    }
    lines
}

/// The input box — three rows tall with a violet border. A `>` prefix
/// marks the prompt, and a trailing `_` serves as a pseudo-cursor so the
/// user's caret position is visible without us having to enable the real
/// terminal cursor (which crossterm hides in raw mode by default).
fn draw_input(f: &mut Frame<'_>, area: Rect, state: &ConversationState) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::PRIMARY))
        .title(Span::styled(
            " input — Enter submit · Shift+Enter newline · Ctrl+C quit ",
            Style::default().fg(theme::MUTED),
        ));

    // Render input with a trailing `_` when we're accepting keys; a dim
    // "…waiting for response…" placeholder when streaming so the user
    // gets feedback that their Enter was received.
    let text = if state.streaming {
        Line::from(Span::styled(
            "…waiting for response…",
            Style::default().fg(theme::MUTED),
        ))
    } else {
        Line::from(vec![
            Span::styled("> ", Style::default().fg(theme::PRIMARY).add_modifier(Modifier::BOLD)),
            Span::raw(state.input.clone()),
            Span::styled("_", Style::default().add_modifier(Modifier::SLOW_BLINK)),
        ])
    };

    let para = Paragraph::new(text).block(block).wrap(Wrap { trim: false });
    f.render_widget(para, area);
}
