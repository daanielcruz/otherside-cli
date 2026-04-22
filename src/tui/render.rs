

use std::time::Duration;

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

use crate::inference::OpenAiChatRole;
use crate::statusline;
use crate::config::settings::PermissionMode;

use super::state::ConversationState;
use super::{autocomplete, layout as layout_mod, mascot, progress, tips};

pub mod theme {
    use ratatui::style::Color;

    pub const PRIMARY: Color = Color::Rgb(0x3E, 0xA0, 0xC3);

    pub const TEXT: Color = Color::Rgb(0xD4, 0xD4, 0xD4);

    pub const MUTED: Color = Color::Rgb(153, 153, 153);

    pub const SUBTLE: Color = Color::Rgb(80, 80, 80);

    pub const USER_MSG_BG: Color = Color::Rgb(55, 55, 55);

    pub const PROMPT_BORDER: Color = Color::Rgb(136, 136, 136);

    pub const ERROR: Color = Color::Rgb(255, 107, 128);

    pub const WARNING: Color = Color::Rgb(255, 193, 7);

    pub const SUCCESS: Color = Color::Rgb(78, 186, 101);

    pub const SUGGESTION: Color = Color::Rgb(177, 185, 249);

    pub const USER_BG: Color = Color::Rgb(55, 55, 55);

    // Queued-message chip palette mirrors upstream's 256-color scheme:
    //   reconstructed/2.1.117/source/components/messages/HighlightedThinkingText.tsx:24,91,99
    //   reconstructed/2.1.117/source/components/messages/UserPromptMessage.tsx:113-119
    // subtle(239) for the pointer, text(231) for the body, userMessageBackground(237) for the band.
    pub const QUEUE_PREFIX: Color = Color::Indexed(239);
    pub const QUEUE_TEXT: Color = Color::Indexed(231);
    pub const QUEUE_BG: Color = Color::Indexed(237);

    pub const DIFF_ADDED: Color = Color::Rgb(56, 166, 96);
    pub const DIFF_REMOVED: Color = Color::Rgb(179, 89, 107);

    pub const ACCENT_AMBER: Color = Color::Rgb(215, 119, 87);

    pub const AUTO_ACCEPT: Color = Color::Rgb(72, 170, 170);

    pub const PLAN_MODE: Color = Color::Rgb(72, 150, 140);

    pub const CHIP_ERROR: Color = Color::Rgb(171, 43, 63);

    pub const BASH_BORDER: Color = Color::Rgb(253, 93, 177);

    pub const PERMISSION: Color = Color::Indexed(153);

    pub fn color_for(chip: super::super::state::ChipColor) -> Color {
        use super::super::state::ChipColor;
        match chip {
            ChipColor::PlanMode => PLAN_MODE,
            ChipColor::AutoAccept => AUTO_ACCEPT,
            ChipColor::Error => CHIP_ERROR,
        }
    }
}

pub fn render(
    f: &mut Frame<'_>,
    state: &ConversationState,
    model: &str,
    provider_id: &str,
    spinner_tick: u64,
) {
    let area = f.area();

    let popup_rows: u16 = {
        let remaining = area.height.saturating_sub(4 + 1 + 3 + 1);
        if let Some(p) = state.pending_permission.as_ref() {
            let mut rows: u16 = 2 + (super::menu::PERMISSION_CHOICES.len() as u16) * 2 + 2;
            if !p.args_preview.is_empty() { rows += 1; }
            if p.rule.is_some() { rows += 1; }
            rows.min(remaining)
        } else if let Some(q) = state.pending_question.as_ref() {
            let question_rows = q.question.lines().count() as u16;
            let hint_rows = if q.hint.is_some() { 1 } else { 0 };
            (1 + question_rows + hint_rows + 4).min(remaining)
        } else if let Some(panel) = state.active_agents_panel.as_ref() {
            let body_rows = match panel.tab {
                super::slash::agents_panel::Tab::Running => {
                    if panel.running.is_empty() { 1 } else { panel.running.len() as u16 }
                }
                super::slash::agents_panel::Tab::Library => {
                    1 + panel.library.len() as u16
                }
            };
            (body_rows + 5).min(remaining).max(8)
        } else if let Some(m) = state.active_menu.as_ref() {
            super::menu::overlay_rows(m).min(remaining)
        } else if let Some(ac) = state.autocomplete.as_ref() {
            let matches_rows = ac.matches.len() as u16;
            let cap = autocomplete::MAX_POPUP_ROWS as u16;
            matches_rows.min(cap).min(remaining)
        } else {
            0
        }
    };

    let slots = layout_mod::split_frame(
        area,
        state.streaming,
        state.queued_messages.len(),
        popup_rows,
    );

    if state.messages.is_empty() && !state.streaming {
        draw_splash_centered(f, slots.streaming);
    } else if state.show_post_clear_splash {
        let splash_rows = slots.streaming.height / 2;
        let splash_area = Rect {
            x: slots.streaming.x,
            y: slots.streaming.y,
            width: slots.streaming.width,
            height: splash_rows,
        };
        let log_area = Rect {
            x: slots.streaming.x,
            y: slots.streaming.y + splash_rows,
            width: slots.streaming.width,
            height: slots.streaming.height.saturating_sub(splash_rows),
        };
        if splash_area.height > 0 {
            draw_splash_centered(f, splash_area);
        }
        if log_area.height > 0 {
            draw_log(f, log_area, state, spinner_tick);
        }
    } else {
        draw_log(f, slots.streaming, state, spinner_tick);
    }

    if let (Some(pr), Some(tp)) = (slots.progress, slots.tip) {

        let verb = state.turn_verb.unwrap_or("Thinking");
        let teammate_name: Option<String> = state
            .active_tool_calls
            .iter()
            .rev()
            .find(|e| {
                e.name == "Agent"
                    && matches!(e.status, super::tool_render::ToolStatus::Running)
                    && {
                        let task_id = crate::tasks::TaskId::from_string(e.id.clone());
                        !state
                            .tasks
                            .get(&task_id)
                            .map(|r| r.is_backgrounded)
                            .unwrap_or(false)
                    }
            })
            .and_then(|e| {
                e.args
                    .get("subagent_type")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
        progress::draw(
            f,
            pr,
            spinner_tick,
            verb,
            Duration::from_millis(state.elapsed_ms()),
            state.input_tokens,
            state.total_output_tokens(),
            state.thought_ms,
            state.session.effort_label,
            teammate_name.as_deref(),
        );
        if state.persistence.settings.show_tips.unwrap_or(true) {
            tips::draw(f, tp, state.tip_rotation_index);
        }
    }

    if let Some(queue_area) = slots.queue {
        draw_queue_lines(f, queue_area, state);
    }

    // Bug S: hide the prompt/input bar when a full-screen overlay is
    // active (agents panel, settings menu, permission prompt, question
    // modal). Upstream blocks input during overlay display so the user
    // doesn't type into a hidden field. Keep it visible only when the
    // overlay is just the autocomplete popup (which is anchored to the
    // live input).
    let overlay_hides_prompt = state.pending_permission.is_some()
        || state.pending_question.is_some()
        || state.active_agents_panel.is_some()
        || state.active_menu.is_some();
    if !overlay_hides_prompt {
        draw_prompt(f, slots.prompt, state);
    }

    if let Some(popup_rect) = slots.popup {
        if let Some(prompt) = state.pending_permission.as_ref() {
            super::menu::draw_permission_prompt(f, popup_rect, prompt);
        } else if let Some(q) = state.pending_question.as_ref() {
            super::menu::draw_question_prompt(f, popup_rect, q);
        } else if let Some(panel) = state.active_agents_panel.as_ref() {
            super::slash::agents_panel::draw_panel(f, popup_rect, panel);
        } else if let Some(menu_state) = state.active_menu.as_ref() {
            super::menu::draw_overlay(f, popup_rect, menu_state);
        } else if let Some(ac) = state.autocomplete.as_ref() {
            autocomplete::draw(f, popup_rect, ac);
        }
    }

    let _ = provider_id;
    if slots.statusline.height > 0 {
        draw_statusline(f, slots.statusline, state, model, provider_id);
    }
    if slots.info.height > 0 {
        draw_info_row(f, slots.info, state, model);
    }
}

fn draw_splash_centered(f: &mut Frame<'_>, area: Rect) {
    mascot::draw_splash(f, area);
}

fn draw_log(f: &mut Frame<'_>, area: Rect, state: &ConversationState, spinner_tick: u64) {
    let mut lines: Vec<Line> = Vec::new();
    let width = area.width;

    let mut first_paint = true;
    for msg in state.messages.iter().filter(|m| !m.is_synthetic) {
        if !first_paint {
            lines.push(Line::raw(""));
        }
        first_paint = false;
        lines.extend(render_message(msg.role, &msg.content, width));
    }

    if !state.active_tool_calls.is_empty() {
        for entry in &state.active_tool_calls {
            lines.push(Line::raw(""));
            let task_id = crate::tasks::TaskId::from_string(entry.id.clone());
            let is_backgrounded = state
                .tasks
                .get(&task_id)
                .map(|r| r.is_backgrounded)
                .unwrap_or(false);
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
                verbose: state.render_verbose,
                spinner_tick,
                nested_entries: &entry.nested_entries,
                is_backgrounded,
            };
            lines.extend(super::tool_render::render_tool_call(&view));
        }
    }

    if state.streaming {

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
    if let Some(err) = &state.last_error {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            format!("error: {err}"),
            Style::default().fg(theme::ERROR).add_modifier(Modifier::BOLD),
        )));
    }

    f.render_widget(Clear, area);

    let inner_h = area.height;
    let probe = Paragraph::new(lines.clone()).wrap(Wrap { trim: false });
    let total_lines = probe.line_count(area.width) as u16;

    if total_lines <= inner_h {
        let render_area = Rect {
            x: area.x,
            y: area.y + inner_h.saturating_sub(total_lines),
            width: area.width,
            height: total_lines,
        };
        let para = Paragraph::new(lines).wrap(Wrap { trim: false });
        f.render_widget(para, render_area);
    } else {
        let para = Paragraph::new(lines).wrap(Wrap { trim: false });
        let max_top = total_lines.saturating_sub(inner_h);
        let top = max_top.saturating_sub(state.scroll_offset as u16);
        f.render_widget(para.scroll((top, 0)), area);
    }
}

fn render_message(role: OpenAiChatRole, content: &str, width: u16) -> Vec<Line<'static>> {

    if role == OpenAiChatRole::Assistant {
        let _ = width;
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

                unreachable!("Assistant role handled via markdown path");
            }
            OpenAiChatRole::System => {

                if raw.starts_with("⎿ ") && i == 0 {
                    lines.push(Line::from(vec![
                        Span::styled(
                            "  ".to_string(),
                            Style::default().fg(theme::MUTED),
                        ),
                        Span::styled(
                            raw.to_string(),
                            Style::default()
                                .fg(theme::MUTED)
                                .add_modifier(Modifier::ITALIC),
                        ),
                    ]));
                } else if raw.starts_with("✻ ") && i == 0 {

                    lines.push(Line::from(Span::styled(
                        raw.to_string(),
                        Style::default()
                            .fg(theme::MUTED)
                            .add_modifier(Modifier::ITALIC),
                    )));
                } else if raw.starts_with("⏺ ") && i == 0 {
                    lines.push(Line::from(Span::styled(
                        raw.to_string(),
                        Style::default().fg(theme::TEXT),
                    )));
                } else {
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
            }
            OpenAiChatRole::Tool => {

                if i > 0 {
                    continue;
                }
                match serde_json::from_str::<super::tool_render::ToolCallArchive>(raw) {
                    Ok(archive) => {
                        let view = archive.view();
                        for line in super::tool_render::render_tool_call(&view) {
                            lines.push(line);
                        }
                    }
                    Err(_) => {

                        let bullet = if cfg!(target_os = "macos") { "⏺ " } else { "● " };
                        lines.push(Line::from(vec![
                            Span::styled(
                                bullet.to_string(),
                                Style::default()
                                    .fg(theme::MUTED)
                                    .add_modifier(Modifier::BOLD),
                            ),
                            Span::styled(
                                raw.to_string(),
                                Style::default().fg(theme::MUTED),
                            ),
                        ]));
                    }
                }
            }
        }
    }
    lines
}

fn draw_queue_lines(f: &mut Frame<'_>, area: Rect, state: &ConversationState) {
    if area.height == 0 || state.queued_messages.is_empty() {
        return;
    }
    let total_rows = area.height as usize;
    // Upstream inserts a blank row between the streaming/loading trailer and
    // the queue chip (context/QueuedMessageContext.tsx:27 `marginTop={1}`).
    let body_budget = total_rows.saturating_sub(1);

    let mut lines: Vec<Line<'_>> = Vec::with_capacity(total_rows);
    lines.push(Line::from(""));
    for msg in state.queued_messages.iter().take(body_budget) {
        let first_line = msg.lines().next().unwrap_or("");
        lines.push(queue_preview_row(first_line, area.width));
    }

    f.render_widget(Paragraph::new(lines), area);
}

fn queue_preview_row(body: &str, width: u16) -> Line<'static> {
    // paddingX=2 on the chip — components/messages/QueuedMessage.tsx:4,24.
    const SIDE_PAD: usize = 2;
    let prefix = "❯ ";
    let prefix_style = Style::default()
        .fg(theme::QUEUE_PREFIX)
        .bg(theme::QUEUE_BG);
    let body_style = Style::default()
        .fg(theme::QUEUE_TEXT)
        .bg(theme::QUEUE_BG);
    let pad_style = Style::default().bg(theme::QUEUE_BG);

    let prefix_cols = prefix.chars().count();
    let width_usize = width as usize;
    let reserved = SIDE_PAD.saturating_mul(2).saturating_add(prefix_cols);
    let max_body_cols = width_usize.saturating_sub(reserved);
    let preview = truncate_for_width(body, max_body_cols);
    let preview_cols = preview.chars().count();

    let pad = " ".repeat(SIDE_PAD);
    let mut spans = vec![
        Span::styled(pad.clone(), pad_style),
        Span::styled(prefix.to_string(), prefix_style),
        Span::styled(preview, body_style),
    ];
    // Extend the bg band through the trailing padding and any unused columns,
    // so the shaded chip spans the full width of the queue slot.
    let used = SIDE_PAD.saturating_add(prefix_cols).saturating_add(preview_cols);
    let trailing = width_usize.saturating_sub(used);
    if trailing > 0 {
        spans.push(Span::styled(" ".repeat(trailing), pad_style));
    }
    Line::from(spans)
}

fn truncate_for_width(s: &str, max_cols: usize) -> String {
    if max_cols == 0 {
        return String::new();
    }
    let char_count = s.chars().count();
    if char_count <= max_cols {
        return s.to_string();
    }
    let keep = max_cols.saturating_sub(1);
    let mut out: String = s.chars().take(keep).collect();
    out.push('…');
    out
}

fn draw_prompt(f: &mut Frame<'_>, area: Rect, state: &ConversationState) {
    let block = Block::default()
        .borders(Borders::TOP | Borders::BOTTOM)
        .border_style(Style::default().fg(theme::PROMPT_BORDER));

    // Input bar stays at full contrast while streaming — upstream keeps
    // the prompt live so users can queue the next turn as they read the
    // stream. Previously both chevron + text got Modifier::DIM during
    // streaming, which made the whole row look disabled (bug O).
    let chevron_style = Style::default().fg(theme::PROMPT_BORDER);
    let text_style = Style::default().fg(theme::TEXT);
    let show_queue_hint = state.input.is_empty() && !state.queued_messages.is_empty();

    let mut spans = vec![Span::styled("❯ ", chevron_style)];
    if show_queue_hint {
        spans.push(Span::styled(
            "Press up to edit queued messages".to_string(),
            Style::default()
                .fg(theme::MUTED)
                .add_modifier(Modifier::DIM),
        ));
    } else {
        spans.push(Span::styled(state.input.clone(), text_style));
    }

    let para = Paragraph::new(Line::from(spans))
        .block(block)
        .wrap(Wrap { trim: false });
    f.render_widget(para, area);

    if !state.streaming {

        let cx = area.x + 2 + state.input.chars().count() as u16;
        let cy = area.y + 1;
        let max_x = area.x + area.width.saturating_sub(1);
        f.set_cursor_position((cx.min(max_x), cy));
    }
}

fn draw_statusline(
    f: &mut Frame<'_>,
    area: Rect,
    state: &ConversationState,
    model: &str,
    provider_id: &str,
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

    let (canonical, has_1m) =
        crate::translator::anthropic::strip_1m_suffix(model);

    let base = crate::inference::model_display::public_model_display_name(&canonical)
        .unwrap_or(&canonical)
        .to_string();
    let display_name = if has_1m {
        format!("{base} [1M]")
    } else {
        base.clone()
    };

    let window = state.session.context_window;
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
        provider_id: provider_id.to_string(),
    };

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

fn draw_info_row(
    f: &mut Frame<'_>,
    area: Rect,
    state: &ConversationState,
    model: &str,
) {
    let _ = model;

    let left = if let Some((msg, _stamped)) = state.toggle_feedback.as_ref() {
        Line::from(Span::styled(
            msg.clone(),
            Style::default().fg(theme::MUTED),
        ))
    } else if state.scroll_offset > 0 {
        Line::from(Span::styled(
            format!(
                "scrolled {} · PgDn/Ctrl+End to return",
                state.scroll_offset
            ),
            Style::default().fg(theme::MUTED),
        ))
    } else {
        build_info_chip_line(state)
    };

    let total = state.input_tokens.saturating_add(state.output_tokens);
    let right_text = build_token_right_chip(state, total);

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

const AUTOCOMPACT_BUFFER_TOKENS: u64 = 13_000;
const WARNING_THRESHOLD_BUFFER_TOKENS: u64 = 20_000;

fn auto_compact_enabled(state: &ConversationState) -> bool {
    state.persistence.settings.auto_compact.unwrap_or(true)
}

fn build_token_right_chip(state: &ConversationState, total: u64) -> String {
    if total == 0 {
        return String::new();
    }
    if state.session.context_window == 0 {
        return format!("{total} tokens");
    }
    let threshold = state
        .session
        .context_window
        .saturating_sub(AUTOCOMPACT_BUFFER_TOKENS);
    let warning_threshold = threshold.saturating_sub(WARNING_THRESHOLD_BUFFER_TOKENS);
    if state.input_tokens < warning_threshold || threshold == 0 {
        return format!("{total} tokens");
    }
    let remaining = threshold.saturating_sub(state.input_tokens);
    let percent_left = ((remaining as u128 * 100) / threshold as u128) as u64;
    if auto_compact_enabled(state) {
        format!("{percent_left}% until auto-compact")
    } else {
        format!("Context low ({percent_left}% remaining) · Run /compact")
    }
}

fn build_info_chip_line(state: &ConversationState) -> Line<'static> {
    if let Some(key) = state.exit_armed_key {
        return Line::from(Span::styled(
            format!("Press {key} again to exit"),
            Style::default().fg(theme::MUTED),
        ));
    }
    let chip_opt = state.permission_mode_label();
    let has_chip = chip_opt.is_some();

    let task_pill = if crate::tasks::is_disabled() {
        None
    } else {
        // Pill tracks BACKGROUNDED tasks only — not foreground-running.
        // Upstream shows `N local agent(s)` after the user Ctrl+B's; during
        // a foreground tool turn the spinner + inline tool view are the
        // feedback path, not the statusline pill.
        crate::tasks::pill_label::get_pill_label(state.tasks.counts_backgrounded())
    };
    let has_task_pill = task_pill.is_some();

    let primary_item_count: usize =
        (has_chip as usize) + (has_task_pill as usize);
    let show_cycle_hint = primary_item_count < 2;

    let hint = if state.autocomplete.is_some() {
        "enter run · esc close"
    } else {
        ""
    };

    let mut spans: Vec<Span<'static>> = Vec::new();
    if let Some(chip) = chip_opt {
        let chip_color = theme::color_for(chip.color);
        spans.push(Span::styled(
            format!("{} ", chip.symbol),
            Style::default().fg(chip_color).add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            chip.text.clone(),
            Style::default().fg(chip_color),
        ));
        if show_cycle_hint {
            spans.push(Span::styled(
                " (shift+tab to cycle)".to_string(),
                Style::default().fg(theme::MUTED),
            ));
        }
    }
    if let Some(pill) = task_pill {

        let segment = if has_chip {
            format!(" · {pill}")
        } else {
            pill
        };
        // Bug Q: upstream highlights the `N background tasks` pill with a
        // cyan background to cue the user that ↓ + Enter opens the panel.
        // Show the separator dot in muted but the pill itself in accent.
        if has_chip {
            let (sep, body) = segment.split_at(3); // " · "
            spans.push(Span::styled(sep.to_string(), Style::default().fg(theme::MUTED)));
            spans.push(Span::styled(
                body.to_string(),
                Style::default()
                    .fg(theme::TEXT)
                    .bg(theme::AUTO_ACCEPT)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            spans.push(Span::styled(
                segment,
                Style::default()
                    .fg(theme::TEXT)
                    .bg(theme::AUTO_ACCEPT)
                    .add_modifier(Modifier::BOLD),
            ));
        }
    }
    if !hint.is_empty() {
        let text = if has_chip || has_task_pill {
            format!(" · {hint}")
        } else {
            hint.to_string()
        };
        spans.push(Span::styled(text, Style::default().fg(theme::SUBTLE)));
    }
    Line::from(spans)
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

        assert_eq!(lines[0].spans[0].content, "❯ ");

        assert_eq!(lines[1].spans[0].content, "  ");
        assert_eq!(lines[1].spans[0].style.bg, Some(theme::USER_BG));

        assert_eq!(line_width(&lines[0]), 80);
        assert_eq!(line_width(&lines[1]), 80);
    }

    #[test]
    fn render_message_user_wraps_under_width_still_fills() {

        let lines = render_message(OpenAiChatRole::User, "x", 12);
        assert_eq!(line_width(&lines[0]), 12);
        for span in &lines[0].spans {
            assert_eq!(span.style.bg, Some(theme::USER_BG));
        }
    }


    #[test]
    fn render_log_splices_tool_call_lines_between_messages_and_buffer() {

        use crate::tui::state::{ConversationState, DisplayMessage};
        use crate::tui::tool_render::ToolStatus;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let mut st = ConversationState::new();
        st.messages.push(DisplayMessage {
            role: OpenAiChatRole::User,
            content: "list files".into(),
            wire_override: None,
            origin: crate::tui::state::DisplayOrigin::Transcript,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        st.begin_tool_call(
            "t1".into(),
            "Glob".into(),
            serde_json::json!({ "pattern": "*.rs" }),
        );

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

        assert!(
            content.contains("●") || content.contains("⏺"),
            "bullet absent: {content:?}"
        );

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

        assert!(content.contains("5 file"));

        assert_eq!(st.active_tool_calls[0].status, ToolStatus::Ok);
    }

    #[test]
    fn render_message_assistant_has_no_user_bg() {

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

    #[test]
    fn theme_color_for_plan_mode_is_sage() {
        use super::super::state::ChipColor;
        use ratatui::style::Color;

        assert_eq!(theme::color_for(ChipColor::PlanMode), Color::Rgb(72, 150, 140));
    }

    #[test]
    fn theme_color_for_auto_accept_is_teal_cyan_distinct_from_primary() {
        use super::super::state::ChipColor;
        use ratatui::style::Color;

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

        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.session.permission_mode = PermissionMode::Default;
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
        st.session.permission_mode = PermissionMode::Plan;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(rendered.contains("⏸"), "rendered: {rendered:?}");
        assert!(rendered.contains("plan mode on"), "rendered: {rendered:?}");
    }

    #[test]
    fn accept_edits_mode_info_row_renders_chevron_glyph_and_label() {
        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.session.permission_mode = PermissionMode::AcceptEdits;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(rendered.contains("⏵⏵"), "rendered: {rendered:?}");
        assert!(rendered.contains("accept edits on"), "rendered: {rendered:?}");
    }

    #[test]
    fn yolo_mode_info_row_renders_chevron_glyph_and_yolo_label() {
        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.session.permission_mode = PermissionMode::Yolo;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(rendered.contains("⏵⏵"), "rendered: {rendered:?}");

        assert!(rendered.contains("yolo on"), "rendered: {rendered:?}");
        assert!(
            !rendered.contains("bypass permissions"),
            "rendered: {rendered:?}"
        );
    }

    #[test]
    fn cycle_hint_shown_when_only_mode_chip_is_primary() {

        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.session.permission_mode = PermissionMode::Plan;
        let rendered = render_info_row_to_string(&st, 120);
        assert!(
            rendered.contains("(shift+tab to cycle)"),
            "rendered: {rendered:?}"
        );
    }

    #[test]
    fn cycle_hint_absent_in_default_mode() {

        use super::super::state::ConversationState;
        use crate::config::PermissionMode;
        let mut st = ConversationState::new();
        st.session.permission_mode = PermissionMode::Default;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(
            !rendered.contains("(shift+tab to cycle)"),
            "rendered: {rendered:?}"
        );
    }

    #[test]
    fn info_row_right_side_renders_raw_token_sum() {

        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        st.input_tokens = 12_345;
        st.output_tokens = 6_789;
        let rendered = render_info_row_to_string(&st, 80);
        assert!(rendered.contains("19134 tokens"), "rendered: {rendered:?}");
        assert!(!rendered.contains("↑"), "rendered: {rendered:?}");
        assert!(!rendered.contains("↓"), "rendered: {rendered:?}");
        assert!(!rendered.contains("Σ"), "rendered: {rendered:?}");
        assert!(!rendered.contains("19k"), "rendered: {rendered:?}");
    }

    fn render_queue_lines_to_string(
        state: &ConversationState,
        width: u16,
        height: u16,
    ) -> String {
        use ratatui::backend::TestBackend;
        use ratatui::layout::Rect;
        use ratatui::Terminal;
        let backend = TestBackend::new(width, height);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| {
            let area = Rect::new(0, 0, width, height);
            draw_queue_lines(f, area, state);
        })
        .unwrap();
        let buf = term.backend().buffer().clone();
        let mut out = String::new();
        for y in 0..height {
            for x in 0..width {
                out.push_str(buf[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn queue_renders_one_row_per_message() {
        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        st.queued_messages.push("first queued".into());
        st.queued_messages.push("second queued".into());

        let s = render_queue_lines_to_string(&st, 80, 3);
        assert!(s.contains("❯ first queued"), "rendered: {s:?}");
        assert!(s.contains("❯ second queued"), "rendered: {s:?}");
    }

    #[test]
    fn draw_queue_lines_renders_all_messages_no_overflow_summary_at_three() {
        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        st.queued_messages.push("msg-0".into());
        st.queued_messages.push("msg-1".into());
        st.queued_messages.push("msg-2".into());

        // slot = count + 1 margin row (matches layout.rs QUEUE_CHROME_ROWS).
        let s = render_queue_lines_to_string(&st, 80, 4);
        assert!(s.contains("❯ msg-0"), "rendered: {s:?}");
        assert!(s.contains("❯ msg-1"), "rendered: {s:?}");
        assert!(s.contains("❯ msg-2"), "rendered: {s:?}");
        assert!(!s.contains("more queued"), "overflow summary leaked: {s:?}");
    }

    #[test]
    fn queue_truncates_long_messages() {
        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        let long: String = "x".repeat(200);
        st.queued_messages.push(long);

        let s = render_queue_lines_to_string(&st, 40, 2);
        assert!(s.contains("❯ "), "chevron missing: {s:?}");
        assert!(s.contains('…'), "ellipsis missing: {s:?}");
    }

    #[test]
    fn queue_preview_row_renders_with_upstream_colors_and_no_dim() {
        use super::super::state::ConversationState;
        use ratatui::backend::TestBackend;
        use ratatui::layout::Rect;
        use ratatui::style::Color;
        use ratatui::Terminal;

        let mut st = ConversationState::new();
        st.queued_messages.push("queued msg".into());

        let width: u16 = 40;
        let height: u16 = 2;
        let backend = TestBackend::new(width, height);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| {
            let area = Rect::new(0, 0, width, height);
            draw_queue_lines(f, area, &st);
        })
        .unwrap();
        let buf = term.backend().buffer().clone();

        // Row 0 is the margin-top blank, row 1 holds the chip.
        let chip_row: u16 = 1;
        let pad_cell = &buf[(0, chip_row)];
        assert_eq!(pad_cell.bg, Color::Indexed(237), "leading pad bg: {:?}", pad_cell);
        assert!(
            !pad_cell.modifier.contains(Modifier::DIM),
            "leading pad carries DIM: {:?}",
            pad_cell
        );

        // Prefix glyph sits at x=2 after the 2-col left pad.
        let prefix_cell = &buf[(2, chip_row)];
        assert_eq!(prefix_cell.symbol(), "❯", "prefix glyph: {:?}", prefix_cell);
        assert_eq!(prefix_cell.fg, Color::Indexed(239), "prefix fg: {:?}", prefix_cell);
        assert_eq!(prefix_cell.bg, Color::Indexed(237), "prefix bg: {:?}", prefix_cell);
        assert!(
            !prefix_cell.modifier.contains(Modifier::DIM),
            "prefix carries DIM: {:?}",
            prefix_cell
        );

        // Body cell right after "❯ " (prefix at x=2, space at x=3, body at x=4).
        let body_cell = &buf[(4, chip_row)];
        assert_eq!(body_cell.fg, Color::Indexed(231), "body fg: {:?}", body_cell);
        assert_eq!(body_cell.bg, Color::Indexed(237), "body bg: {:?}", body_cell);
        assert!(
            !body_cell.modifier.contains(Modifier::DIM),
            "body carries DIM: {:?}",
            body_cell
        );

        // Trailing cell at the right edge still wears the bg band.
        let tail_cell = &buf[(width - 1, chip_row)];
        assert_eq!(tail_cell.bg, Color::Indexed(237), "trailing bg: {:?}", tail_cell);
    }

    #[test]
    fn prompt_shows_queue_hint_placeholder_when_queue_has_items_and_input_empty() {
        use super::super::state::ConversationState;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut st = ConversationState::new();

        st.queued_messages.push("stalled follow-up".into());

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
        }
        assert!(
            joined.contains("Press up to edit queued messages"),
            "placeholder missing: {joined:?}"
        );
    }

    #[test]
    fn queue_not_painted_when_empty_in_full_render() {
        use super::super::state::ConversationState;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut st = ConversationState::new();
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

        assert!(!joined.contains("❯ queued-"), "stray queue row: {joined:?}");
    }

    #[test]
    fn queue_lines_painted_when_streaming_and_nonempty() {
        use super::super::state::ConversationState;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut st = ConversationState::new();
        st.input = "hi".into();
        st.submit().unwrap();
        st.push_to_queue("queued-alpha".into());
        st.push_to_queue("queued-beta".into());
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
        assert!(joined.contains("❯ queued-alpha"), "rendered: {joined:?}");
        assert!(joined.contains("❯ queued-beta"), "rendered: {joined:?}");
    }

    #[test]
    fn queue_suppressed_when_idle_even_with_entries() {
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
        assert!(!joined.contains("❯ stranded"), "painted during idle: {joined:?}");
    }

    #[test]
    fn token_chip_shows_until_auto_compact_past_warning_threshold() {
        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        st.session.context_window = 200_000;
        st.input_tokens = 170_000;
        let chip = build_token_right_chip(&st, st.input_tokens);
        assert!(
            chip.contains("until auto-compact"),
            "warning state missing: {chip:?}"
        );
    }

    #[test]
    fn token_chip_shows_context_low_when_auto_compact_disabled_past_threshold() {
        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        st.session.context_window = 200_000;
        st.input_tokens = 175_000;
        st.persistence.settings.auto_compact = Some(false);
        let chip = build_token_right_chip(&st, st.input_tokens);
        assert!(
            chip.contains("Context low") && chip.contains("Run /compact"),
            "error state missing: {chip:?}"
        );
    }

    #[test]
    fn token_chip_uses_input_plus_output_not_cumulative() {

        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        st.input_tokens = 23_298;
        st.output_tokens = 539;
        st.cumulative_output_tokens = 170;
        let total = st.input_tokens.saturating_add(st.output_tokens);
        let chip = build_token_right_chip(&st, total);
        assert_eq!(chip, "23837 tokens");
        assert!(
            !chip.contains("24007"),
            "cumulative leaked into chip: {chip:?}"
        );
    }

    #[test]
    fn token_chip_grows_across_tool_chain_sub_turns() {

        use super::super::state::ConversationState;
        let mut st = ConversationState::new();
        let mut samples: Vec<u64> = Vec::new();
        let push_sample = |st: &ConversationState, samples: &mut Vec<u64>| {
            samples.push(st.input_tokens.saturating_add(st.output_tokens));
        };

        st.update_usage(Some(20_000), None);
        push_sample(&st, &mut samples);
        st.update_usage(None, Some(50));
        push_sample(&st, &mut samples);

        st.update_usage(Some(21_000), None);
        push_sample(&st, &mut samples);
        st.update_usage(None, Some(120));
        push_sample(&st, &mut samples);

        st.update_usage(Some(23_000), None);
        push_sample(&st, &mut samples);
        st.update_usage(None, Some(540));
        push_sample(&st, &mut samples);

        for pair in samples.windows(2) {
            assert!(
                pair[1] >= pair[0],
                "chip total regressed: {pair:?} (full sequence: {samples:?})",
            );
        }

        assert_eq!(samples.last().copied(), Some(23_000 + 540));
    }
}
