//! Drawing functions for the TUI.
//!
//! ratatui is immediate-mode: we re-render everything on every tick.
//! The C44 bottom-up frame is owned by `tui::layout`; this module
//! composes the individual drawers (mascot, progress, tip, autocomplete,
//! statusline, streaming, prompt, info row) into the slots it returns.
//!
//! # Theme constants
//!
//! All user-tunable colors live in [`theme`] below. Every widget reads
//! them; editing here recolors the whole interface on the next frame.

use std::time::Duration;

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::inference::OpenAiChatRole;
use crate::statusline;
use crate::config::settings::PermissionMode;

use super::state::ConversationState;
use super::{autocomplete, layout as layout_mod, mascot, progress, tips};

/// Visual theme. Edit these constants to recolor the entire TUI.
pub mod theme {
    use ratatui::style::Color;

    // ----- otherside-native -----

    /// Light blue — PRIMARY accent. Reserved for the spinner glyph
    /// and the thinking verb ONLY. Everything else mirrors upstream's
    /// palette so the TUI reads as familiar.
    pub const PRIMARY: Color = Color::Rgb(0x3E, 0xA0, 0xC3);

    // ----- upstream palette (mirrored for parity) -----

    /// White — body text.
    pub const TEXT: Color = Color::Rgb(255, 255, 255);

    /// Light gray — ambient helper text (tip line, shortcut hints,
    /// context chips when under threshold).
    pub const MUTED: Color = Color::Rgb(153, 153, 153);

    /// Dark gray — very dim secondary detail.
    pub const SUBTLE: Color = Color::Rgb(80, 80, 80);

    /// User message background — upstream `theme.ts:488` dark-theme
    /// `userMessageBackground: rgb(55, 55, 55)`. Darker grey strip
    /// that spans the user turn's full width so the chevron + text
    /// read as one continuous element distinct from the assistant
    /// bullet band.
    pub const USER_MSG_BG: Color = Color::Rgb(55, 55, 55);

    /// Medium gray — prompt-bar border.
    pub const PROMPT_BORDER: Color = Color::Rgb(136, 136, 136);

    /// Bright red — errors and the mascot's corrupted-core accent
    /// on `/clear`.
    pub const ERROR: Color = Color::Rgb(255, 107, 128);

    /// Amber — warnings.
    pub const WARNING: Color = Color::Rgb(255, 193, 7);

    /// Green — success.
    pub const SUCCESS: Color = Color::Rgb(78, 186, 101);

    /// Light blue-purple — slash popup suggestions.
    pub const SUGGESTION: Color = Color::Rgb(177, 185, 249);

    /// User-message background fill.
    pub const USER_BG: Color = Color::Rgb(55, 55, 55);

    /// Diff coloring (word-level).
    pub const DIFF_ADDED: Color = Color::Rgb(56, 166, 96);
    pub const DIFF_REMOVED: Color = Color::Rgb(179, 89, 107);

    /// Warm amber — assistant bullet + mascot core. Neutral name so
    /// identity-zone widgets carry no upstream provenance.
    pub const ACCENT_AMBER: Color = Color::Rgb(215, 119, 87);

    /// Auto-accept-edits permission mode chip color.
    pub const AUTO_ACCEPT: Color = Color::Rgb(175, 135, 255);

    /// Plan mode chip.
    pub const PLAN_MODE: Color = Color::Rgb(72, 150, 140);

    /// Bash prefix (`!` prompt) border.
    pub const BASH_BORDER: Color = Color::Rgb(253, 93, 177);
}

/// Public entry — carves `f.area()` via `layout::split_frame` and
/// paints every region. Mascot fills the streaming area when the
/// session is empty; otherwise the streaming log renders.
pub fn render(
    f: &mut Frame<'_>,
    state: &ConversationState,
    model: &str,
    provider_id: &str,
    spinner_tick: u64,
) {
    let area = f.area();
    let slots = layout_mod::split_frame(area, state.streaming);

    // Streaming area — mascot when empty, otherwise the scrolling log.
    if state.messages.is_empty() && !state.streaming {
        draw_splash_centered(f, slots.streaming);
    } else {
        draw_log(f, slots.streaming, state, spinner_tick);
    }

    // Progress + tip rows only exist when streaming.
    if let (Some(pr), Some(tp)) = (slots.progress, slots.tip) {
        // Verb is seeded once per turn in submit() and held stable
        // under spinner-frame tick rotation. Fall back to "Thinking"
        // on the off chance a draw fires before submit seeds the state.
        let verb = state.turn_verb.unwrap_or("Thinking");
        progress::draw(
            f,
            pr,
            spinner_tick,
            verb,
            Duration::from_millis(state.elapsed_ms()),
            state.output_tokens,
            state.thought_ms,
            state.effort_label,
        );
        tips::draw(f, tp, state.tip_rotation_index);
    }

    // Prompt bar with the autocomplete popup painted above it when
    // active — the popup goes in the streaming area bottom strip so
    // it obscures nothing crucial (we redraw next frame anyway).
    draw_prompt(f, slots.prompt, state);
    if let Some(ac) = state.autocomplete.as_ref() {
        // Popup hangs below the prompt bar, eating into the info-row
        // chrome area if needed. Matches upstream's placement — the
        // user reads the suggestions right above the cursor, not high
        // up in the log.
        let popup_h = (ac.matches.len() as u16).min(slots.streaming.height);
        if popup_h >= 1 {
            let popup = Rect {
                x: slots.streaming.x,
                y: slots.streaming.y + slots.streaming.height.saturating_sub(popup_h),
                width: slots.streaming.width,
                height: popup_h,
            };
            autocomplete::draw(f, popup, ac);
        }
    }

    // Statusline — native path for now; subprocess override hook
    // lands with state.settings plumbing. No provider_id — the locked
    // emoji fallback drops it per C67.
    let _ = provider_id;
    draw_statusline(f, slots.statusline, state, model);

    // Info row — bottom chrome with permission mode + shortcut hint.
    draw_info_row(f, slots.info, state, model);
}

/// Hand `mascot::draw_splash` the full streaming area so it can own
/// the top-pad / mascot / gap / banner / gap / tagline stack. The
/// mascot module falls back to a short legend internally when the
/// frame can't fit the full layout.
fn draw_splash_centered(f: &mut Frame<'_>, area: Rect) {
    mascot::draw_splash(f, area);
}

/// Scrolling message log. Each finalized message is rendered as a
/// role-prefix line followed by a single blank row of padding; the
/// in-flight assistant buffer gets the same treatment while
/// `streaming` is true. No horizontal rules — upstream log is a
/// plain scrolling region, the prompt bar carries the borders.
fn draw_log(f: &mut Frame<'_>, area: Rect, state: &ConversationState, spinner_tick: u64) {
    let mut lines: Vec<Line> = Vec::new();
    let width = area.width;

    for (i, msg) in state.messages.iter().enumerate() {
        if i > 0 {
            lines.push(Line::raw(""));
        }
        lines.extend(render_message(msg.role, &msg.content, width));
    }

    if state.streaming {
        // Only surface the assistant message once real content has
        // started streaming — while we're still waiting for the first
        // delta, the spinner band below the log owns the loading
        // signal. Doubling up with a bulleted spinner up here reads
        // like two separate states.
        if !state.current_assistant_buffer.is_empty() {
            if !state.messages.is_empty() {
                lines.push(Line::raw(""));
            }
            lines.extend(render_message(
                OpenAiChatRole::Assistant,
                &state.current_assistant_buffer,
                width,
            ));
        }
    }
    let _ = spinner_tick;

    if let Some(err) = &state.last_error {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            format!("error: {err}"),
            Style::default().fg(theme::ERROR).add_modifier(Modifier::BOLD),
        )));
    }

    // Bottom-anchor the conversation: when the log is shorter than
    // the streaming area, paint it in the BOTTOM portion of the rect
    // so empty space sits ABOVE the messages — mirrors upstream
    // ScrollBox which anchors to the newest turn next to the prompt
    // bar. When the log overflows, scroll so the latest line is on
    // the bottom edge; a user-scrolled `scroll_offset` walks back up.
    let total_lines = lines.len() as u16;
    let inner_h = area.height;
    let para = Paragraph::new(lines).wrap(Wrap { trim: false });

    if total_lines <= inner_h {
        // Fits entirely — render in a bottom-aligned sub-rect.
        let render_area = Rect {
            x: area.x,
            y: area.y + inner_h.saturating_sub(total_lines),
            width: area.width,
            height: total_lines,
        };
        f.render_widget(para, render_area);
    } else {
        // Overflow — scroll so the newest line sits on the bottom edge.
        // scroll_offset walks the view upward from there.
        let max_top = total_lines.saturating_sub(inner_h);
        let top = max_top.saturating_sub(state.scroll_offset as u16);
        f.render_widget(para.scroll((top, 0)), area);
    }
}

/// Produce one-or-more lines for a single message. Per upstream TUI
/// convention (no `user:` / `assistant:` text labels), visual role
/// cues are:
///
/// - **User** — dark-gray background that runs the full frame width
///   (mirrors upstream's `userMessageBackground`) with a leading `>`
///   arrow on the first line, 2-space indent on continuation lines.
/// - **Assistant** — plain white text, no prefix, no background.
/// - **System** — italic muted grey prefaced by `⎿ system:`.
/// - **Tool** — muted grey prefaced by `⎿ tool:` (legacy path; the
///   real tool-call render moves to `tui::tool_render` once 005 wires).
fn render_message(role: OpenAiChatRole, content: &str, width: u16) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (i, raw) in content.split('\n').enumerate() {
        match role {
            OpenAiChatRole::User => {
                // Upstream `components/messages/UserCommandMessage.tsx`
                // ships the user turn with a `userMessageBackground`
                // fill — dark slate `rgb(55,55,55)` on dark themes. The
                // chevron matches the prompt-bar rule color so the user
                // turn reads as a continuation of the input band.
                let _ = width;
                let prefix = if i == 0 { "❯ " } else { "  " };
                let bg = Style::default()
                    .bg(theme::USER_MSG_BG)
                    .fg(theme::TEXT);
                lines.push(Line::from(vec![
                    Span::styled(
                        prefix.to_string(),
                        bg.fg(theme::PROMPT_BORDER),
                    ),
                    Span::styled(raw.to_string(), bg),
                ]));
            }
            OpenAiChatRole::Assistant => {
                if i == 0 {
                    let bullet = if cfg!(target_os = "macos") { "⏺ " } else { "● " };
                    // Assistant bullet is WHITE per upstream — the
                    // PRIMARY accent is reserved for tool-call state
                    // (gray blink while running, green on success).
                    lines.push(Line::from(vec![
                        Span::styled(
                            bullet.to_string(),
                            Style::default()
                                .fg(theme::TEXT)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(raw.to_string(), Style::default().fg(theme::TEXT)),
                    ]));
                } else {
                    lines.push(Line::from(Span::styled(
                        raw.to_string(),
                        Style::default().fg(theme::TEXT),
                    )));
                }
            }
            OpenAiChatRole::System => {
                let prefix = if i == 0 { "⎿ system: " } else { "           " };
                lines.push(Line::from(vec![
                    Span::styled(
                        prefix.to_string(),
                        Style::default()
                            .fg(theme::MUTED)
                            .add_modifier(Modifier::ITALIC),
                    ),
                    Span::styled(
                        raw.to_string(),
                        Style::default()
                            .fg(theme::MUTED)
                            .add_modifier(Modifier::ITALIC),
                    ),
                ]));
            }
            OpenAiChatRole::Tool => {
                let prefix = if i == 0 { "⎿ tool: " } else { "         " };
                lines.push(Line::from(vec![
                    Span::styled(
                        prefix.to_string(),
                        Style::default().fg(theme::SUGGESTION),
                    ),
                    Span::styled(
                        raw.to_string(),
                        Style::default().fg(theme::MUTED),
                    ),
                ]));
            }
        }
    }
    lines
}

/// Prompt bar with upstream-style top + bottom rule lines (no left
/// or right border box), a `❯` heavy-chevron prompt, and the live
/// input buffer. During streaming the buffer stays visible but
/// dimmed — upstream never substitutes copy, and swapping text flickers.
fn draw_prompt(f: &mut Frame<'_>, area: Rect, state: &ConversationState) {
    let block = Block::default()
        .borders(Borders::TOP | Borders::BOTTOM)
        .border_style(Style::default().fg(theme::PROMPT_BORDER));

    // Chevron + cursor share the prompt-bar rule color so the
    // input band reads as one continuous element. Dim while the
    // request is inflight — upstream keeps the input visible but
    // muted so the user knows it's locked.
    let chevron_style = if state.streaming {
        Style::default()
            .fg(theme::PROMPT_BORDER)
            .add_modifier(Modifier::DIM)
    } else {
        Style::default().fg(theme::PROMPT_BORDER)
    };
    let text_style = if state.streaming {
        Style::default()
            .fg(theme::TEXT)
            .add_modifier(Modifier::DIM)
    } else {
        Style::default().fg(theme::TEXT)
    };
    let spans = vec![
        Span::styled("❯ ", chevron_style),
        Span::styled(state.input.clone(), text_style),
    ];

    let para = Paragraph::new(Line::from(spans))
        .block(block)
        .wrap(Wrap { trim: false });
    f.render_widget(para, area);

    // Let the terminal paint its native block cursor at the input
    // tail — upstream relies on the terminal caret shape (block by
    // default) rather than a drawn `_` glyph. Skip while streaming
    // so the inflight dimmed input doesn't show an active cursor.
    if !state.streaming {
        // Chevron "❯ " is 2 columns wide; input flows from column 2.
        // `.block(TOP|BOTTOM)` eats one row at top + bottom — the
        // input sits on area.y + 1.
        let cx = area.x + 2 + state.input.chars().count() as u16;
        let cy = area.y + 1;
        let max_x = area.x + area.width.saturating_sub(1);
        f.set_cursor_position((cx.min(max_x), cy));
    }
}

/// Statusline row — single muted line painted bottom-of-band.
/// Dispatches through the statusline subsystem so a user-supplied
/// `settings.statusline.command` can replace the native fallback.
fn draw_statusline(
    f: &mut Frame<'_>,
    area: Rect,
    state: &ConversationState,
    model: &str,
) {
    use statusline::types::{
        ContextWindowInput, CostInput, ModelInput, OutputStyleInput, StatuslineCtx,
        StatuslineInput, WorkspaceInput,
    };

    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let home = directories::BaseDirs::new()
        .map(|b| b.home_dir().to_string_lossy().into_owned());

    // Reuse the canonical stripper so display-layer matches wire-layer
    // semantics (case-insensitive `[1m]` anywhere in the string).
    let (canonical, has_1m) =
        crate::translator::openai_to_anthropic::strip_1m_suffix(model);
    let display_name =
        crate::inference::model_display::render_model_name(&canonical, has_1m);

    let window = state.context_window;
    let used = window.saturating_sub(state.context_available());
    let pct = state.context_used_percent();

    let payload = StatuslineInput {
        session_id: String::new(),
        transcript_path: String::new(),
        cwd: cwd.clone(),
        session_name: None,
        model: ModelInput {
            id: canonical.to_string(),
            display_name,
            extra: Default::default(),
        },
        workspace: WorkspaceInput {
            current_dir: cwd.clone(),
            project_dir: cwd,
            added_dirs: Vec::new(),
            extra: Default::default(),
        },
        version: env!("CARGO_PKG_VERSION").to_string(),
        output_style: OutputStyleInput {
            name: "default".to_string(),
            extra: Default::default(),
        },
        cost: CostInput {
            total_cost_usd: 0.0,
            total_duration_ms: 0,
            total_api_duration_ms: 0,
            total_lines_added: 0,
            total_lines_removed: 0,
            extra: Default::default(),
        },
        context_window: ContextWindowInput {
            total_input_tokens: 0,
            total_output_tokens: state.output_tokens,
            context_window_size: window,
            current_usage: used,
            used_percentage: pct as u64,
            remaining_percentage: (100u32.saturating_sub(pct)) as u64,
            extra: Default::default(),
        },
        exceeds_200k_tokens: used > 200_000,
        rate_limits: None,
        vim: None,
        agent: None,
        remote: None,
        worktree: None,
        extra: Default::default(),
    };
    let ctx = StatuslineCtx {
        payload,
        terminal_width: area.width,
        home_dir: home,
        permission_mode: PermissionMode::Default,
        custom_env: Default::default(),
    };

    // TODO(012b/014b): thread the actual `settings.statusline` config
    // through here once settings is wired into render state. For now the
    // None path triggers the native emoji-prefixed fallback.
    let (line, _warn) = statusline::dispatch(&ctx, None);
    let stripped = strip_ansi(&line.content);
    let para = Paragraph::new(Line::from(Span::styled(
        stripped,
        Style::default().fg(theme::MUTED),
    )));
    f.render_widget(para, area);
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_escape = false;
    for ch in s.chars() {
        if in_escape {
            if ch.is_ascii_alphabetic() {
                in_escape = false;
            }
            continue;
        }
        if ch == '\x1b' {
            in_escape = true;
            continue;
        }
        out.push(ch);
    }
    out
}

/// Info row — absolute bottom line. Mirrors upstream's shape:
/// left side carries the permission-mode chip + shortcut text,
/// right side carries token count + model. Context-driven hint
/// flips based on state (streaming / autocomplete / idle).
fn draw_info_row(
    f: &mut Frame<'_>,
    area: Rect,
    state: &ConversationState,
    model: &str,
) {
    // Left side: permission-mode chip (⏵⏵) + shortcut hint.
    let mode_chip = match state.permission_mode_label() {
        // The label method returns a tuple (glyph, text) — but to keep
        // this minimal until the permission layer lands, we pick a
        // sensible default matching upstream's "accept edits on" copy.
        (_, text) => text,
    };
    let hint = if state.streaming {
        " · esc to interrupt"
    } else if state.autocomplete.is_some() {
        " · enter run · esc close"
    } else if state.input.is_empty() {
        ""
    } else {
        " · enter to submit"
    };
    let _ = model;
    // Right side: context hint / status — empty on idle, populated
    // when a recognized secondary signal exists (deferred until the
    // permission engine + MCP status are plumbed through the TUI).
    let right_text = String::new();

    let left = Line::from(vec![
        Span::styled(
            "⏵⏵ ",
            Style::default()
                .fg(theme::SUCCESS)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(mode_chip, Style::default().fg(theme::MUTED)),
        Span::styled(hint.to_string(), Style::default().fg(theme::SUBTLE)),
    ]);

    if right_text.is_empty() {
        f.render_widget(Paragraph::new(left), area);
    } else {
        let right_len = (right_text.chars().count() + 2) as u16;
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Min(10),
                Constraint::Length(right_len.max(10)),
            ])
            .split(area);
        f.render_widget(Paragraph::new(left), chunks[0]);
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                right_text,
                Style::default().fg(theme::MUTED),
            )))
            .alignment(Alignment::Right),
            chunks[1],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_color_escapes() {
        let with = "\x1b[38;2;81;21;140mhello\x1b[0m";
        assert_eq!(strip_ansi(with), "hello");
    }

    #[test]
    fn strip_ansi_preserves_plain_text() {
        assert_eq!(strip_ansi("plain"), "plain");
    }
}
