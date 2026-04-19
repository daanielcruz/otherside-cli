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
//!
//! # Tool-call interleave (015)
//!
//! [`draw_log`] splices [`tool_render::render_tool_call`] output for
//! every entry in `state.active_tool_calls` after the finalized
//! message paint and before the in-flight `current_assistant_buffer`
//! paint. Ordering mirrors upstream's transcript: user → assistant
//! text → tool calls for this turn → assistant text after tool results.
//! The entries clear on [`ConversationState::submit`], so prior-turn
//! tool calls don't leak into a new turn's render.
//!
//! # User message background (015)
//!
//! [`render_message`] for role `User` emits every span with
//! `Style::bg(theme::USER_BG)` plus a trailing filler span sized to
//! `width - used` so the fill extends to the frame edge. The first
//! line carries a muted `)` chevron; continuation lines indent with
//! two spaces on the same background.

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

    /// Auto-accept-edits permission mode chip color — teal-leaning
    /// cyan. Upstream `autoAccept` ships violet `rgb(175,135,255)` but
    /// that collides with otherside PRIMARY (blue-violet) and the
    /// `#51158C` brand; C69 picked a distinct hue to keep the three
    /// accents visually separable on the info row.
    pub const AUTO_ACCEPT: Color = Color::Rgb(72, 170, 170);

    /// Plan mode chip — sage, mirrors upstream `planMode`
    /// `rgb(72,150,140)` with no color collision against PRIMARY.
    pub const PLAN_MODE: Color = Color::Rgb(72, 150, 140);

    /// Dark-theme error red for high-risk permission chips (yolo /
    /// bypass). Upstream `theme.ts:137` dark-theme `error`
    /// `rgb(171,43,63)`. Distinct from `ERROR` above (which is the
    /// brighter inline-error copy color) so the chip reads as a
    /// standing state rather than a transient error string.
    pub const CHIP_ERROR: Color = Color::Rgb(171, 43, 63);

    /// Bash prefix (`!` prompt) border.
    pub const BASH_BORDER: Color = Color::Rgb(253, 93, 177);

    /// Resolve a [`super::super::state::ChipColor`] discriminant to a
    /// concrete ratatui color. Single lookup point so the permission
    /// chip render path never embeds inline RGB (C46).
    pub fn color_for(chip: super::super::state::ChipColor) -> Color {
        use super::super::state::ChipColor;
        match chip {
            ChipColor::PlanMode => PLAN_MODE,
            ChipColor::AutoAccept => AUTO_ACCEPT,
            ChipColor::Error => CHIP_ERROR,
        }
    }
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
            state.input_tokens,
            state.thought_ms,
            state.effort_label,
        );
        tips::draw(f, tp, state.tip_rotation_index);
    }

    // Queue chip (017 §4) — rendered in the always-reserved 1-row
    // prompt top-pad gap so it hugs the prompt bar without shifting
    // layout. Visible only while streaming and the queue is non-empty;
    // otherwise the gap stays blank (its original purpose).
    if state.streaming && state.has_queued_messages() && slots.prompt.y > 0 {
        let chip_area = Rect {
            x: slots.prompt.x,
            y: slots.prompt.y - 1,
            width: slots.prompt.width,
            height: 1,
        };
        draw_queue_chip(f, chip_area, state);
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

    // Tool-call splice (015) — paint in-flight + finalized tool calls
    // for the current turn BETWEEN finalized messages and the in-flight
    // assistant buffer. Each entry's bullet color reflects its status:
    // MUTED + SLOW_BLINK while Running, SUCCESS solid on Ok, ERROR
    // solid on Error. Order = insertion order = upstream transcript
    // ordering. active_tool_calls clears on submit so prior turns
    // never double-paint.
    if !state.active_tool_calls.is_empty() {
        for entry in &state.active_tool_calls {
            lines.push(Line::raw(""));
            let view = super::tool_render::ToolCallView {
                name: &entry.name,
                args: &entry.args,
                status: entry.status,
                elapsed_ms: if entry.elapsed_ms > 0 {
                    Some(entry.elapsed_ms)
                } else {
                    None
                },
                payload: entry.payload.as_ref(),
            };
            lines.extend(super::tool_render::render_tool_call(&view));
        }
    }

    if state.streaming {
        // Only surface the assistant message once real content has
        // started streaming — while we're still waiting for the first
        // delta, the spinner band below the log owns the loading
        // signal. Doubling up with a bulleted spinner up here reads
        // like two separate states.
        if !state.current_assistant_buffer.is_empty() {
            if !state.messages.is_empty() || !state.active_tool_calls.is_empty() {
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
///   (mirrors upstream's `userMessageBackground`) with a leading
///   muted `)` chevron on the first line, 2-space indent on
///   continuation lines. Every line carries a trailing filler span
///   sized to `width - used` so the background reaches the frame
///   edge (ratatui's `Wrap` does not pad to width by default).
/// - **Assistant** — plain white text, no prefix, no background.
/// - **System** — italic muted grey prefaced by `⎿ system:`.
/// - **Tool** — muted grey prefaced by `⎿ tool:` (legacy path; the
///   real tool-call render lives at `tui::tool_render`, wired via
///   `ConversationState::active_tool_calls` per 015).
fn render_message(role: OpenAiChatRole, content: &str, width: u16) -> Vec<Line<'static>> {
    // Assistant content is markdown — render the whole block through
    // `tui::markdown::render` so `**bold**`, backtick code, lists,
    // headings, and links get their styled spans. Prefix the first
    // rendered line with the assistant bullet. Every other role
    // keeps the per-line path below.
    if role == OpenAiChatRole::Assistant {
        let _ = width; // markdown carves its own widths
        let mut rendered = super::markdown::render(content);
        let bullet = if cfg!(target_os = "macos") { "⏺ " } else { "● " };
        let bullet_span = Span::styled(
            bullet.to_string(),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        );
        if rendered.is_empty() {
            return vec![Line::from(bullet_span)];
        }
        // Splice the bullet into the first non-empty line so a leading
        // blank paragraph (shouldn't happen in practice) doesn't push
        // the bullet off-screen.
        let first_idx = rendered
            .iter()
            .position(|l| !l.spans.is_empty())
            .unwrap_or(0);
        let head = std::mem::take(&mut rendered[first_idx]);
        let mut spans: Vec<Span<'static>> = Vec::with_capacity(head.spans.len() + 1);
        spans.push(bullet_span);
        spans.extend(head.spans);
        rendered[first_idx] = Line::from(spans);
        return rendered;
    }

    let mut lines: Vec<Line<'static>> = Vec::new();
    for (i, raw) in content.split('\n').enumerate() {
        match role {
            OpenAiChatRole::User => {
                // 015 Bug B — match upstream's `userMessageBackground`
                // fill with a muted `)` chevron. The background spans
                // every span on every line via `Style::bg(USER_BG)`;
                // a trailing filler extends the fill to the frame
                // edge because ratatui's `Wrap` doesn't pad to width.
                let prefix = if i == 0 { "❯ " } else { "  " };
                let prefix_style = if i == 0 {
                    Style::default().fg(theme::MUTED).bg(theme::USER_BG)
                } else {
                    Style::default().bg(theme::USER_BG)
                };
                let body_style = Style::default().fg(theme::TEXT).bg(theme::USER_BG);
                let used = prefix.chars().count() + raw.chars().count();
                let filler_len = (width as usize).saturating_sub(used);
                let mut spans: Vec<Span<'static>> = Vec::with_capacity(3);
                spans.push(Span::styled(prefix.to_string(), prefix_style));
                spans.push(Span::styled(raw.to_string(), body_style));
                if filler_len > 0 {
                    spans.push(Span::styled(
                        " ".repeat(filler_len),
                        Style::default().bg(theme::USER_BG),
                    ));
                }
                lines.push(Line::from(spans));
            }
            OpenAiChatRole::Assistant => {
                // Handled above via markdown::render — unreachable
                // because we early-return before the loop for Assistant.
                unreachable!("Assistant role handled via markdown path");
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
                // Role::Tool carries a `format_tool_history_entry`
                // pipe-delimited summary: `status|name|elapsed|args`.
                // Paint compact: ● <name>(<args>) · <elapsed>ms. Bullet
                // green on ok, red on err, muted otherwise.
                if i > 0 {
                    continue;
                }
                let parts: Vec<&str> = raw.splitn(4, '|').collect();
                let (status, name, elapsed_ms, args) = match parts.as_slice() {
                    [s, n, e, a] => (*s, *n, *e, *a),
                    _ => ("", raw, "0", ""),
                };
                let bullet_color = match status {
                    "ok" => theme::SUCCESS,
                    "err" => theme::ERROR,
                    _ => theme::MUTED,
                };
                let bullet = if cfg!(target_os = "macos") { "⏺ " } else { "● " };
                let elapsed_chip = elapsed_ms
                    .parse::<u64>()
                    .ok()
                    .filter(|&n| n > 0)
                    .map(|n| format!(" · {n}ms"))
                    .unwrap_or_default();
                let mut spans: Vec<Span<'static>> = Vec::with_capacity(4);
                spans.push(Span::styled(
                    bullet.to_string(),
                    Style::default()
                        .fg(bullet_color)
                        .add_modifier(Modifier::BOLD),
                ));
                spans.push(Span::styled(
                    name.to_string(),
                    Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
                ));
                if !args.is_empty() {
                    spans.push(Span::styled(
                        format!("({args})"),
                        Style::default().fg(theme::MUTED),
                    ));
                }
                if !elapsed_chip.is_empty() {
                    spans.push(Span::styled(
                        elapsed_chip,
                        Style::default().fg(theme::MUTED),
                    ));
                }
                lines.push(Line::from(spans));
            }
        }
    }
    lines
}

/// Paint the 017 §4 queue chip: `⏸ N queued · press up to edit`.
/// Single MUTED line, no border. Caller confirms queue non-empty +
/// stream active + at least one pixel of top-pad to render into.
fn draw_queue_chip(f: &mut Frame<'_>, area: Rect, state: &ConversationState) {
    let count = state.queued_messages.len();
    let text = format!("⏸ {count} queued · press up to edit");
    let para = Paragraph::new(Line::from(Span::styled(
        text,
        Style::default().fg(theme::MUTED),
    )));
    f.render_widget(para, area);
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
///
/// Permission chip rendering follows upstream
/// `components/PromptInput/PromptInputFooterLeftSide.tsx:348-367`:
/// Default mode hides the chip entirely (upstream `hasActiveMode`
/// gate); every other mode emits `<symbol> <label> on` in a
/// mode-specific color token. The `(shift+tab to cycle)` hint is
/// suffixed when `primaryItemCount < 2` (line 349). For 016 MVP the
/// mode chip is the only "primary" chip, so the gate is effectively
/// always-show — the counter is wired so future chips (tool-state /
/// PR-status / tasks) automatically activate the hide-hint branch
/// when they land. See 016 design.md §"Cycle hint visibility gate".
fn draw_info_row(
    f: &mut Frame<'_>,
    area: Rect,
    state: &ConversationState,
    model: &str,
) {
    let _ = model;

    // Primary chip counter — 016 MVP only tallies the permission
    // chip. Future pillars will extend this as they add their own
    // primary chips (tool state, PR status, tasks). Cycle hint
    // mirrors upstream `primaryItemCount < 2` gate.
    let chip_opt = state.permission_mode_label();
    let has_chip = chip_opt.is_some();
    let primary_item_count: usize = if has_chip { 1 } else { 0 };
    let show_cycle_hint = primary_item_count < 2;

    // Hint text WITHOUT a leading separator — we only inject " · "
    // below when there's chip content to its left. Default mode has no
    // chip, so the hint must not render with a leading bullet.
    let hint = if state.streaming {
        "esc to interrupt"
    } else if state.autocomplete.is_some() {
        "enter run · esc close"
    } else {
        ""
    };

    // Left side: permission chip (symbol + label) when active, then
    // the context hint. Default mode collapses the chip entirely —
    // matches upstream's absent `modePart`.
    let mut spans: Vec<Span<'static>> = Vec::new();
    if let Some(chip) = chip_opt {
        let chip_color = theme::color_for(chip.color);
        // Symbol is bold and carries the chip's color; single space
        // separates symbol from label (matches upstream format).
        spans.push(Span::styled(
            format!("{} ", chip.symbol),
            Style::default().fg(chip_color).add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            chip.text.clone(),
            Style::default().fg(chip_color),
        ));
        if show_cycle_hint {
            // Cycle hint stays MUTED per user decision — only the
            // chip symbol + label carry the mode color; the
            // parenthetical is ambient chrome, not state.
            spans.push(Span::styled(
                " (shift+tab to cycle)".to_string(),
                Style::default().fg(theme::MUTED),
            ));
        }
    }
    // Prefix the hint with " · " only when there is chip content to
    // its left. Default mode (no chip) renders the hint alone without
    // a leading bullet.
    if !hint.is_empty() {
        let text = if has_chip {
            format!(" · {hint}")
        } else {
            hint.to_string()
        };
        spans.push(Span::styled(text, Style::default().fg(theme::SUBTLE)));
    }

    let left = Line::from(spans);

    // Right side: context hint / status — empty on idle, populated
    // when a recognized secondary signal exists (deferred until the
    // permission engine + MCP status are plumbed through the TUI).
    let right_text = String::new();

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

    // --- 015 user-message background + chevron ---------------------------

    fn line_width(line: &Line<'_>) -> usize {
        line.spans.iter().map(|s| s.content.chars().count()).sum()
    }

    #[test]
    fn render_message_user_has_userbg_on_every_span() {
        let lines = render_message(OpenAiChatRole::User, "hello", 80);
        assert_eq!(lines.len(), 1);
        for span in &lines[0].spans {
            assert_eq!(
                span.style.bg,
                Some(theme::USER_BG),
                "span {:?} missing USER_BG",
                span.content
            );
        }
    }

    #[test]
    fn render_message_user_chevron_is_muted() {
        let lines = render_message(OpenAiChatRole::User, "hello", 80);
        let first = &lines[0].spans[0];
        assert_eq!(first.content, "❯ ");
        assert_eq!(first.style.fg, Some(theme::MUTED));
        assert_eq!(first.style.bg, Some(theme::USER_BG));
    }

    #[test]
    fn render_message_user_background_extends_to_width() {
        let lines = render_message(OpenAiChatRole::User, "hi", 80);
        assert_eq!(line_width(&lines[0]), 80);
    }

    #[test]
    fn render_message_user_continuation_lines_indent_with_bg() {
        let lines = render_message(OpenAiChatRole::User, "line1\nline2", 80);
        assert_eq!(lines.len(), 2);
        // First line carries the chevron.
        assert_eq!(lines[0].spans[0].content, "❯ ");
        // Continuation line indents with two spaces — no chevron.
        assert_eq!(lines[1].spans[0].content, "  ");
        assert_eq!(lines[1].spans[0].style.bg, Some(theme::USER_BG));
        // Both lines fill to the width.
        assert_eq!(line_width(&lines[0]), 80);
        assert_eq!(line_width(&lines[1]), 80);
    }

    #[test]
    fn render_message_user_wraps_under_width_still_fills() {
        // Short message at narrow width — filler span handles the
        // remaining cells so the bg covers every column.
        let lines = render_message(OpenAiChatRole::User, "x", 12);
        assert_eq!(line_width(&lines[0]), 12);
        for span in &lines[0].spans {
            assert_eq!(span.style.bg, Some(theme::USER_BG));
        }
    }

    #[test]
    fn render_log_splices_tool_call_lines_between_messages_and_buffer() {
        // Integration-level spot check — draw against a TestBackend
        // and inspect the cell grid for the Running bullet.
        use crate::tui::state::{ConversationState, DisplayMessage};
        use crate::tui::tool_render::ToolStatus;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let mut st = ConversationState::new();
        st.messages.push(DisplayMessage {
            role: OpenAiChatRole::User,
            content: "list files".into(),
        });
        st.begin_tool_call(
            "t1".into(),
            "Glob".into(),
            serde_json::json!({ "pattern": "*.rs" }),
        );
        // Running state expected.
        let backend = TestBackend::new(80, 20);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| {
            let area = f.area();
            draw_log(f, area, &st, 0);
        })
        .expect("draw");
        let buf = term.backend().buffer().clone();
        let content: String = buf
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        assert!(content.contains("Glob"), "tool name absent: {content:?}");
        // Header has no explicit "running" text now — upstream format
        // conveys status via bullet color only. Test buffer lacks ANSI,
        // so we only guarantee the name + bullet glyph are present.
        assert!(
            content.contains("●") || content.contains("⏺"),
            "bullet absent: {content:?}"
        );

        // Transition to Ok — bullet color + status text flips.
        st.finish_tool_call("t1", Ok(serde_json::json!({ "numFiles": 5 })), 77);
        term.draw(|f| {
            let area = f.area();
            draw_log(f, area, &st, 1);
        })
        .expect("draw 2");
        let buf = term.backend().buffer().clone();
        let content: String = buf
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        // Status "ok" + elapsed "77ms" no longer render on the header
        // (upstream format). Color transition is in the span style,
        // not the plain-text buffer. Preview line still shows the
        // file count via the payload gutter.
        assert!(content.contains("5 file"));

        // Sanity — status enum actually transitioned.
        assert_eq!(st.active_tool_calls[0].status, ToolStatus::Ok);
    }

    #[test]
    fn render_message_assistant_has_no_user_bg() {
        // Guardrail: Bug B changes must NOT bleed into the Assistant
        // branch. Assistant keeps a PRIMARY bullet + plain TEXT body
        // with no background fill.
        let lines = render_message(OpenAiChatRole::Assistant, "reply", 80);
        for line in &lines {
            for span in &line.spans {
                assert_ne!(
                    span.style.bg,
                    Some(theme::USER_BG),
                    "assistant span {:?} leaked USER_BG",
                    span.content
                );
            }
        }
        let bullet = &lines[0].spans[0].content;
        assert!(
            bullet == "⏺ " || bullet == "● ",
            "bullet glyph unexpected: {bullet:?}"
        );
    }

    // ----- 016: permission chip render wiring -----

    #[test]
    fn theme_color_for_plan_mode_is_sage() {
        use super::super::state::ChipColor;
        use ratatui::style::Color;
        // Upstream `theme.ts:441` dark-theme `planMode` sage mirror.
        assert_eq!(theme::color_for(ChipColor::PlanMode), Color::Rgb(72, 150, 140));
    }

    #[test]
    fn theme_color_for_auto_accept_is_teal_cyan_distinct_from_primary() {
        use super::super::state::ChipColor;
        use ratatui::style::Color;
        // C69 distinct-hue — MUST NOT equal PRIMARY to keep the
        // blue-violet family from collapsing into one visual cluster.
        let color = theme::color_for(ChipColor::AutoAccept);
        assert_eq!(color, Color::Rgb(72, 170, 170));
        assert_ne!(color, theme::PRIMARY);
    }

    #[test]
    fn theme_color_for_error_chip_is_dark_red() {
        use super::super::state::ChipColor;
        use ratatui::style::Color;
        assert_eq!(theme::color_for(ChipColor::Error), Color::Rgb(171, 43, 63));
    }

    /// Render just the info-row rect into a `TestBackend`, then collect
    /// the cells as a plain string so test asserts can grep the output.
    fn render_info_row_to_string(
        state: &super::super::state::ConversationState,
        width: u16,
    ) -> String {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(width, 1);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| {
            let area = f.area();
            draw_info_row(f, area, state, "test-model");
        })
        .expect("draw");
        let buf = term.backend().buffer().clone();
        let mut out = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                out.push_str(buf.cell((x, y)).expect("cell").symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn default_mode_renders_no_chip() {
        // Per upstream `hasActiveMode` gate, Default mode's info row
        // must not carry any chip glyph or label.
        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.permission_mode = PermissionMode::Default;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(!rendered.contains("⏸"), "rendered: {rendered:?}");
        assert!(!rendered.contains("⏵⏵"), "rendered: {rendered:?}");
        assert!(!rendered.contains("plan mode"), "rendered: {rendered:?}");
        assert!(!rendered.contains("accept edits"), "rendered: {rendered:?}");
        assert!(!rendered.contains("yolo"), "rendered: {rendered:?}");
    }

    #[test]
    fn plan_mode_info_row_renders_pause_glyph_and_label() {
        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.permission_mode = PermissionMode::Plan;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(rendered.contains("⏸"), "rendered: {rendered:?}");
        assert!(rendered.contains("plan mode on"), "rendered: {rendered:?}");
    }

    #[test]
    fn accept_edits_mode_info_row_renders_chevron_glyph_and_label() {
        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.permission_mode = PermissionMode::AcceptEdits;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(rendered.contains("⏵⏵"), "rendered: {rendered:?}");
        assert!(rendered.contains("accept edits on"), "rendered: {rendered:?}");
    }

    #[test]
    fn yolo_mode_info_row_renders_chevron_glyph_and_yolo_label() {
        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.permission_mode = PermissionMode::Yolo;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(rendered.contains("⏵⏵"), "rendered: {rendered:?}");
        // Identity-zone brand: `yolo on`, not `bypass permissions on`.
        assert!(rendered.contains("yolo on"), "rendered: {rendered:?}");
        assert!(
            !rendered.contains("bypass permissions"),
            "rendered: {rendered:?}"
        );
    }

    #[test]
    fn cycle_hint_shown_when_only_mode_chip_is_primary() {
        // 016 MVP: mode chip is the only primary item, so the hint is
        // always shown for any non-Default mode.
        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.permission_mode = PermissionMode::Plan;
        let rendered = render_info_row_to_string(&st, 120);
        assert!(
            rendered.contains("(shift+tab to cycle)"),
            "rendered: {rendered:?}"
        );
    }

    #[test]
    fn cycle_hint_absent_in_default_mode() {
        // No chip at all means no hint either — Default mode renders
        // a truly empty info row (ignoring stream/input hints).
        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.permission_mode = PermissionMode::Default;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(
            !rendered.contains("(shift+tab to cycle)"),
            "rendered: {rendered:?}"
        );
    }

    // --- 017 §4 queue chip -----------------------------------------------

    fn render_queue_chip_to_string(state: &ConversationState, width: u16) -> String {
        use ratatui::backend::TestBackend;
        use ratatui::layout::Rect;
        use ratatui::Terminal;
        let backend = TestBackend::new(width, 1);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| {
            let area = Rect::new(0, 0, width, 1);
            draw_queue_chip(f, area, state);
        })
        .unwrap();
        let buf = term.backend().buffer().clone();
        let mut out = String::new();
        for x in 0..width {
            out.push_str(buf[(x, 0)].symbol());
        }
        out.trim_end().to_string()
    }

    #[test]
    fn queue_chip_renders_count_and_hint() {
        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        st.queued_messages.push("A".into());
        st.queued_messages.push("B".into());
        let s = render_queue_chip_to_string(&st, 80);
        assert!(s.contains("2 queued"), "rendered: {s:?}");
        assert!(s.contains("press up to edit"), "rendered: {s:?}");
        assert!(s.starts_with('⏸') || s.starts_with('\u{23f8}'), "rendered: {s:?}");
    }

    #[test]
    fn queue_chip_count_updates_with_queue_size() {
        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        st.queued_messages.push("A".into());
        let s1 = render_queue_chip_to_string(&st, 80);
        assert!(s1.contains("1 queued"), "rendered: {s1:?}");
        st.queued_messages.push("B".into());
        st.queued_messages.push("C".into());
        let s2 = render_queue_chip_to_string(&st, 80);
        assert!(s2.contains("3 queued"), "rendered: {s2:?}");
    }

    #[test]
    fn queue_chip_not_painted_when_queue_empty_in_full_render() {
        // Full frame render — chip must NOT appear in the top-pad row
        // when the queue is empty.
        use super::super::state::ConversationState;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut st = ConversationState::new();
        // Kick state into streaming so the render path with the chip
        // guard is live — ensures the `has_queued_messages` gate is
        // what blocks the paint, not the streaming check.
        st.input = "hi".into();
        st.submit().unwrap();
        let backend = TestBackend::new(80, 30);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| render(f, &st, "claude-opus-4-7", "anthropic", 0))
            .unwrap();
        let buf = term.backend().buffer().clone();
        let mut joined = String::new();
        for y in 0..30 {
            for x in 0..80 {
                joined.push_str(buf[(x, y)].symbol());
            }
            joined.push('\n');
        }
        assert!(
            !joined.contains("queued · press up to edit"),
            "chip leaked into empty-queue render: {joined:?}"
        );
    }

    #[test]
    fn queue_chip_painted_in_top_pad_when_streaming_and_nonempty() {
        use super::super::state::ConversationState;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut st = ConversationState::new();
        st.input = "hi".into();
        st.submit().unwrap();
        st.push_to_queue("queued-a".into());
        st.push_to_queue("queued-b".into());
        let backend = TestBackend::new(80, 30);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| render(f, &st, "claude-opus-4-7", "anthropic", 0))
            .unwrap();
        let buf = term.backend().buffer().clone();
        let mut joined = String::new();
        for y in 0..30 {
            for x in 0..80 {
                joined.push_str(buf[(x, y)].symbol());
            }
            joined.push('\n');
        }
        assert!(
            joined.contains("2 queued · press up to edit"),
            "chip missing from render: {joined:?}"
        );
    }

    #[test]
    fn queue_chip_suppressed_when_idle_even_with_queue() {
        // Defensive: if the queue somehow has entries while streaming
        // is false (shouldn't happen during normal use — finish_stream
        // drains), the chip must still suppress because it signals a
        // mid-turn waiting state, not a finalized inbox.
        use super::super::state::ConversationState;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut st = ConversationState::new();
        st.queued_messages.push("stranded".into());
        assert!(!st.streaming);
        let backend = TestBackend::new(80, 30);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| render(f, &st, "claude-opus-4-7", "anthropic", 0))
            .unwrap();
        let buf = term.backend().buffer().clone();
        let mut joined = String::new();
        for y in 0..30 {
            for x in 0..80 {
                joined.push_str(buf[(x, y)].symbol());
            }
            joined.push('\n');
        }
        assert!(
            !joined.contains("queued · press up to edit"),
            "chip painted during idle: {joined:?}"
        );
    }
}
