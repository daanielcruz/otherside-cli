

use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{
    DisableMouseCapture, Event as CtEvent, EventStream, KeyCode, KeyEvent,
    KeyEventKind, KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::provider::{Provider, Registry};
use crate::thinking::{parse_suffix, ThinkingConfig};

mod agent_bridge;
pub mod autocomplete;
pub mod diff;
pub mod layout;
pub mod markdown;
pub mod mascot;
pub mod menu;
pub mod progress;
pub mod render;
pub mod slash;
pub mod state;
pub mod tips;
pub mod todos;
pub mod tool_render;

use state::{ConversationState, DisplayOrigin};

#[derive(Debug)]
enum StreamEvent {

    Delta(String),

    Done,

    Error(String),

    ToolCallStart {
        id: String,
        name: String,
        args: serde_json::Value,
    },

    ToolCallFinish {
        id: String,
        result: std::result::Result<serde_json::Value, String>,
        elapsed_ms: u64,
    },

    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },

    PermissionAsk {
        tool_name: String,
        args_preview: String,
        rule: Option<String>,
        reply: tokio::sync::oneshot::Sender<crate::permissions::PermissionResponse>,
    },

    AskUserQuestion {
        question: String,
        hint: Option<String>,
        reply: tokio::sync::oneshot::Sender<String>,
    },

    NestedToolStart {
        name: String,
        args: serde_json::Value,
    },

    NestedToolFinish {
        success: bool,
    },

    NestedUsage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },

    BackgroundAgentCompleted {
        tool_call_id: String,
        summary: String,
    },

    CompactDone {
        summary: String,
        is_auto: bool,
    },

    CompactFailed {
        message: String,
    },
}

#[derive(Debug, Clone, Default)]
pub enum ResumeIntent {
    #[default]
    None,
    Latest,
    Specific(String),
    Picker,
}

pub async fn run(
    registry: Arc<Registry>,
    raw_model: String,
    provider_id: String,
    initial_permission_mode: crate::config::PermissionMode,
    settings: crate::config::settings::Settings,
    resume_intent: ResumeIntent,
) -> Result<()> {
    let provider = registry
        .get(&provider_id)
        .ok_or_else(|| Error::Other(format!("provider {provider_id:?} not registered")))?;

    let (base_model, thinking) = parse_suffix(&raw_model)
        .map_err(|e| Error::Other(format!("invalid model suffix: {e}")))?;

    let mut guard = TerminalGuard::enter()?;
    let res = event_loop(
        &mut guard.terminal,
        provider,
        base_model,
        thinking,
        provider_id,
        initial_permission_mode,
        settings,
        resume_intent,
    )
    .await;
    guard.restore();
    match res {
        Ok(session_id) => {
            if let Some(id) = session_id {
                use std::io::Write as _;
                let mut stdout = std::io::stdout();
                let _ = writeln!(
                    stdout,
                    "\n\x1b[2mResume this session with:\notherside --resume {id}\x1b[0m"
                );
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

async fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    provider: Arc<dyn Provider>,
    base_model: String,
    mut thinking: Option<ThinkingConfig>,
    provider_id: String,
    initial_permission_mode: crate::config::PermissionMode,
    settings: crate::config::settings::Settings,
    resume_intent: ResumeIntent,
) -> Result<Option<crate::sessions::SessionId>> {
    let mut st =
        ConversationState::new_for_model_with_mode(&base_model, initial_permission_mode);

    let _ = crate::tasks::store::install_global(st.tasks.clone());

    st.render_verbose = settings.verbose.unwrap_or(false);

    match crate::config::config_dir() {
        Ok(cfg_dir) => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let resume_outcome: std::result::Result<
                Option<(crate::sessions::SessionHandle, Vec<crate::sessions::Record>)>,
                crate::error::Error,
            > = match &resume_intent {
                ResumeIntent::None => Ok(None),
                ResumeIntent::Latest => crate::sessions::resume_latest(&cfg_dir, &cwd),
                ResumeIntent::Picker => match pick_session_pre_tui(&cfg_dir, &cwd) {
                    PickerOutcome::Resume(id) => {
                        crate::sessions::resume(&cfg_dir, &cwd, &id).map(Some)
                    }
                    PickerOutcome::Latest => crate::sessions::resume_latest(&cfg_dir, &cwd),
                    PickerOutcome::Fresh => Ok(None),
                },
                ResumeIntent::Specific(id_hex) => {
                    match crate::sessions::id::SessionId::from_hex(id_hex) {
                        Some(id) => crate::sessions::resume(&cfg_dir, &cwd, &id).map(Some),
                        None => Err(crate::error::Error::Other(format!(
                            "session id {id_hex:?} is not a valid uuid-like hex"
                        ))),
                    }
                }
            };

            match resume_outcome {
                Ok(Some((handle, records))) => {
                    st.session_id = Some(handle.id.clone());
                    st.session_writer = Some(handle.writer);
                    state::hydrate_from_records(&mut st, &records);
                }
                Ok(None) => {
                    if matches!(resume_intent, ResumeIntent::Latest) {
                        tracing::info!("--continue: no prior session found, starting fresh");
                    }
                    match crate::sessions::open_new(&cfg_dir, &cwd) {
                        Ok(handle) => {
                            st.session_id = Some(handle.id.clone());
                            st.session_writer = Some(handle.writer);
                        }
                        Err(e) => {
                            tracing::warn!(?e, "session transcript unavailable");
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(?e, "resume failed; starting fresh session");
                    match crate::sessions::open_new(&cfg_dir, &cwd) {
                        Ok(handle) => {
                            st.session_id = Some(handle.id.clone());
                            st.session_writer = Some(handle.writer);
                        }
                        Err(e) => {
                            tracing::warn!(?e, "session transcript unavailable");
                        }
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(?e, "config dir unavailable; sessions disabled");
        }
    }

    if thinking.is_none() {
        if let Some(level_str) = settings.effort_level.as_deref() {
            use crate::thinking::{ThinkingConfig, ThinkingLevel};
            use std::str::FromStr;
            if level_str.eq_ignore_ascii_case("auto") {
                thinking = Some(ThinkingConfig::auto());
            } else if let Ok(level) = ThinkingLevel::from_str(level_str) {
                thinking = Some(ThinkingConfig::level(level));
            }
        }
    }
    st.persistence.settings = settings;

    if st.persistence.settings.default_provider.is_none() {
        st.persistence.settings.default_provider = Some(provider_id.to_string());
    }
    if st.persistence.settings.default_model.is_none() {
        st.persistence.settings.default_model = Some(st.session.model.clone());
    }
    if let Err(e) = persist_session_defaults(&st) {
        tracing::warn!(?e, "initial settings write failed");
    }

    st.session.effort_label = thinking
        .as_ref()
        .and_then(|cfg| match cfg.level {
            crate::thinking::ThinkingLevel::Auto | crate::thinking::ThinkingLevel::None => None,
            other => Some(other.as_label()),
        });
    let mut key_stream = EventStream::new();

    let mut ticker = tokio::time::interval(Duration::from_millis(50));
    let mut spinner_tick: u64 = 0;

    let (tx, mut rx) = mpsc::channel::<StreamEvent>(1024);

    st.prune_feedback();
    terminal
        .draw(|f| render::render(f, &st, &st.session.model, &provider_id, spinner_tick))
        .map_err(|e| Error::Tui(format!("draw: {e}")))?;

    loop {
        tokio::select! {

            _ = ticker.tick() => {
                spinner_tick = spinner_tick.wrapping_add(1);

                for entry in crate::tools::cron::drain_due_wakeups() {
                    st.push_system_note(format!("⏰ wakeup: {}", entry.message));
                }

                if let Some(store) = crate::tasks::store::current_global() {
                    for record in store.drain_unrendered_completions() {
                        if matches!(record.kind, crate::tasks::TaskKind::Agent) {
                            continue;
                        }
                        let line = render_completion_line(&record);
                        st.push_system_note(line);
                    }
                }

                let _ = auto_trigger_pending_notifications(
                    &mut st, &provider, &base_model, &thinking, &tx,
                );
            }

            maybe = rx.recv() => {
                match maybe {
                    Some(StreamEvent::Delta(s)) => {
                        tracing::info!(
                            target: "otherside::queue",
                            delta_len = s.len(),
                            buffer_len_after = st.current_assistant_buffer.len() + s.len(),
                            "Delta received"
                        );
                        st.append_stream_delta(&s);
                    }
                    Some(StreamEvent::Done) => {
                        tracing::info!(
                            target: "otherside::queue",
                            queue_depth = st.queued_messages.len(),
                            buffer_len = st.current_assistant_buffer.len(),
                            messages_len = st.messages.len(),
                            "StreamEvent::Done received"
                        );
                        let content = st.current_assistant_buffer.clone();
                        let usage = Some(serde_json::json!({
                            "input_tokens": st.input_tokens,
                            "output_tokens": st.output_tokens,
                            "cumulative_output_tokens": st.cumulative_output_tokens,
                            "thought_ms": st.thought_ms,
                        }));
                        if !content.is_empty() {
                            st.append_record(crate::sessions::Record::AssistantMessage {
                                ts: crate::sessions::record::now_iso(),
                                content,
                                thinking: None,
                                usage,
                            });
                        }
                        st.finish_stream();

                        drain_pending_inputs(
                            &mut st, &provider, &base_model, &thinking, &provider_id, &tx,
                        );
                    }
                    Some(StreamEvent::Error(e)) => {
                        st.fail_stream(e);
                        drain_pending_inputs(
                            &mut st, &provider, &base_model, &thinking, &provider_id, &tx,
                        );
                    }
                    Some(StreamEvent::ToolCallStart { id, name, args }) => {
                        st.flush_assistant_buffer();
                        st.append_record(crate::sessions::Record::ToolCall {
                            ts: crate::sessions::record::now_iso(),
                            tool_name: name.clone(),
                            args: args.clone(),
                            call_id: id.clone(),
                        });
                        st.begin_tool_call(id, name, args);
                    }
                    Some(StreamEvent::ToolCallFinish { id, result, elapsed_ms }) => {
                        let (record_result, is_error) = match &result {
                            Ok(v) => (v.clone(), false),
                            Err(s) => (serde_json::Value::String(s.clone()), true),
                        };
                        st.append_record(crate::sessions::Record::ToolResult {
                            ts: crate::sessions::record::now_iso(),
                            call_id: id.clone(),
                            result: record_result,
                            is_error,
                        });
                        st.finish_tool_call(&id, result, elapsed_ms);
                    }
                    Some(StreamEvent::Usage { input_tokens, output_tokens }) => {
                        st.update_usage(input_tokens, output_tokens);
                    }
                    Some(StreamEvent::PermissionAsk { tool_name, args_preview, rule, reply }) => {

                        st.active_menu = None;
                        st.pending_permission = Some(menu::PendingPermissionPrompt::new(
                            tool_name,
                            args_preview,
                            rule,
                            reply,
                        ));
                    }
                    Some(StreamEvent::AskUserQuestion { question, hint, reply }) => {
                        st.active_menu = None;
                        st.pending_question = Some(menu::PendingQuestion::new(
                            question,
                            hint,
                            reply,
                        ));
                    }
                    Some(StreamEvent::NestedToolStart { name, args }) => {
                        st.push_nested_tool_start(&name, args);
                    }
                    Some(StreamEvent::NestedToolFinish { success }) => {
                        st.push_nested_tool_finish(success);
                    }
                    Some(StreamEvent::NestedUsage { input_tokens, output_tokens }) => {
                        st.push_nested_usage(input_tokens, output_tokens);
                    }
                    Some(StreamEvent::BackgroundAgentCompleted { tool_call_id, summary }) => {
                        let trimmed: String = summary.chars().take(160).collect();
                        st.push_system_note(format!(
                            "⎿  Background agent {tool_call_id} completed: {trimmed}"
                        ));
                        let task_id = crate::tasks::TaskId::from_string(tool_call_id);
                        st.tasks.update_with(&task_id, |r| {
                            if !r.state.is_terminal() {
                                r.state = crate::tasks::TaskState::Completed;
                                r.exit_code = Some(0);
                            }
                            r.inject_on_next_turn = true;
                        });
                    }
                    Some(StreamEvent::CompactDone { summary, is_auto }) => {
                        let kept = st.messages.len() as u64;
                        st.append_record(crate::sessions::Record::CompactionMark {
                            ts: crate::sessions::record::now_iso(),
                            summary_ref: format!("kept={kept};auto={is_auto}"),
                        });
                        st.compact_history_with_summary(Some(summary));
                        st.streaming = false;
                        st.push_system_note("✻ Conversation compacted (ctrl+o for history)");
                        st.push_anchor(
                            "compact",
                            "",
                            "Compacted (ctrl+o to see full summary)",
                            state::DisplayOrigin::Transcript,
                        );
                        drain_pending_inputs(
                            &mut st, &provider, &base_model, &thinking, &provider_id, &tx,
                        );
                    }
                    Some(StreamEvent::CompactFailed { message }) => {
                        st.streaming = false;
                        st.push_system_note(format!("⎿  compact failed: {message}"));
                    }
                    None => {

                        if st.streaming {
                            st.finish_stream();
                            drain_queue_head_if_any(
                                &mut st, &provider, &base_model, &thinking, &provider_id, &tx,
                            );
                        }
                    }
                }
            }

            maybe = key_stream.next() => {
                match maybe {
                    Some(Ok(CtEvent::Key(k))) => {
                        if handle_key(k, &mut st, &provider, &base_model, &mut thinking, &provider_id, &tx) {
                            break;
                        }
                    }
                    Some(Ok(CtEvent::Resize(_, _))) => {

                    }
                    Some(Ok(_)) => {

                    }
                    Some(Err(e)) => {
                        return Err(Error::Tui(format!("event: {e}")));
                    }
                    None => {

                        break;
                    }
                }
            }
        }

        st.prune_feedback();
        terminal
            .draw(|f| render::render(f, &st, &st.session.model, &provider_id, spinner_tick))
            .map_err(|e| Error::Tui(format!("draw: {e}")))?;
    }

    Ok(st.session_id.clone())
}

fn handle_key(
    k: KeyEvent,
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &mut Option<ThinkingConfig>,
    _provider_id: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {

    if k.kind != KeyEventKind::Press {
        return false;
    }

    if st.pending_question.is_some() {
        handle_question_key(k, st);
        return false;
    }

    if st.pending_permission.is_some() {
        handle_permission_key(k, st);
        return false;
    }

    if st.active_agents_panel.is_some() {
        handle_agents_panel_key(k, st);
        return false;
    }

    if st.active_menu.is_some() {
        return handle_menu_key(k, st, thinking);
    }

    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let shift = k.modifiers.contains(KeyModifiers::SHIFT);

    let is_exit_arming_key = ctrl
        && matches!(k.code, KeyCode::Char('c') | KeyCode::Char('d'));
    if !is_exit_arming_key {
        st.clear_exit_armed();
    }

    {
        use crate::keybindings::{dispatch as kb_dispatch, Action, PredicateContext};
        let pred_ctx = PredicateContext {
            tasks: &st.tasks,
            dialog_open: st.active_menu.is_some(),
        };
        if let Some(action) = kb_dispatch(&k, &pred_ctx) {
            match action {
                Action::TaskBackground => {
                    let flipped = st.tasks.background_all_running_foreground();
                    let signalled = crate::tools::background_signal::signal_all();
                    let n = flipped.len().max(signalled.len());
                    if n > 0 {
                        let noun = if n == 1 { "task" } else { "tasks" };
                        st.push_system_note(format!(
                            "⎿  {n} {noun} sent to background"
                        ));
                    }
                    return false;
                }
                Action::OpenBackgroundTasksDialog => {

                    st.push_system_note(
                        "(BackgroundTasksDialog renders in §7 — open via /tasks for now)"
                            .to_string(),
                    );
                    return false;
                }
            }
        }
    }

    match k.code {

        KeyCode::Char('c') if ctrl => {
            if st.cancel_stream() {

            } else if st.exit_confirmed() {
                return true;
            } else {
                st.arm_exit_confirmation("Ctrl+C");
            }
        }

        KeyCode::Esc => {
            if st.autocomplete.is_some() {

                st.close_autocomplete();
                st.clear_input();
            } else if st.streaming {
                st.cancel_stream();
            } else {
                st.clear_input();
            }
            st.clear_exit_armed();
        }

        KeyCode::Char('d') if ctrl && st.input.is_empty() => {
            if st.exit_confirmed() && st.exit_armed_key == Some("Ctrl+D") {
                return true;
            } else {
                st.arm_exit_confirmation("Ctrl+D");
            }
        }

        KeyCode::Char('l') if ctrl => {}

        KeyCode::Char('o') if ctrl => {
            st.render_verbose = !st.render_verbose;
        }

        KeyCode::Char('u') if ctrl => {
            st.input.clear();
            st.refresh_autocomplete();
        }

        KeyCode::PageUp => st.scroll_up(10),
        KeyCode::PageDown => st.scroll_down(10),

        KeyCode::Up if shift => st.scroll_up(1),
        KeyCode::Down if shift => st.scroll_down(1),

        KeyCode::Home if ctrl => st.scroll_up(10_000),
        KeyCode::End if ctrl => st.scroll_to_bottom(),

        KeyCode::Up => {
            if let Some(ac) = st.autocomplete.as_mut() {
                ac.move_up();
            } else if !st.streaming
                && st.input.is_empty()
                && st.has_queued_messages()
            {
                if let Some(tail) = st.pop_queue_tail() {
                    st.input = tail;
                    st.refresh_autocomplete();
                }
            }
        }
        KeyCode::Down => {
            if let Some(ac) = st.autocomplete.as_mut() {
                ac.move_down();
            } else if !st.streaming
                && st.input.is_empty()
                && st.tasks.any_backgrounded()
                && st.active_agents_panel.is_none()
            {
                st.active_agents_panel = Some(
                    crate::tui::slash::agents_panel::AgentsPanelState::new(
                        &st.tasks,
                        crate::agent::subagents::registry::all(),
                    ),
                );
            }
        }

        KeyCode::Tab if shift => {
            if st.autocomplete.is_none() {
                st.cycle_permission_mode();
            }
        }
        KeyCode::BackTab => {
            if st.autocomplete.is_none() {
                st.cycle_permission_mode();
            }
        }
        KeyCode::Tab => {
            if let Some(ac) = st.autocomplete.as_ref() {
                if let Some(name) = ac.commit() {
                    st.input = format!("/{name}");
                    st.close_autocomplete();
                }
            }
        }

        KeyCode::Enter => {
            if shift {
                st.input_push_newline();
                st.refresh_autocomplete();
            } else if st.streaming {
                let trimmed = st.input.trim();
                if !trimmed.is_empty() {
                    st.push_to_queue(st.input.clone());
                }
                st.input.clear();
                st.autocomplete = None;
            } else {
                if let Some(ac) = st.autocomplete.as_ref() {
                    if let Some(name) = ac.commit() {
                        st.input = format!("/{name}");
                    }
                    st.close_autocomplete();
                }
                if dispatch_slash(
                    st,
                    provider,
                    base_model,
                    thinking,
                    tx,
                ) {
                    return true;
                }
            }
        }

        KeyCode::Backspace => {
            st.input_backspace();
            st.refresh_autocomplete();
        }
        KeyCode::Char('h') if ctrl => {
            st.input_backspace();
            st.refresh_autocomplete();
        }

        KeyCode::Char(c) if !ctrl => {
            st.input_push_char(c);
            st.refresh_autocomplete();
        }

        _ => {}
    }

    false
}

fn handle_menu_key(
    k: KeyEvent,
    st: &mut ConversationState,
    thinking: &mut Option<ThinkingConfig>,
) -> bool {
    use crate::tui::slash::catalog::PanelKind;
    if matches!(k.code, KeyCode::Esc) {
        if let Some(menu) = st.active_menu.as_mut() {
            if matches!(menu.kind, PanelKind::Settings(_))
                && !menu.settings_search_query.is_empty()
            {
                menu.settings_search_query.clear();
                menu.cursor = 0;
                return false;
            }
        }
        if let Some(menu) = st.active_menu.take() {
            emit_panel_dismiss_anchor(st, &menu, None);
        }
        return false;
    }
    let Some(menu_state) = st.active_menu.as_mut() else {
        return false;
    };

    if let PanelKind::Settings(_) = menu_state.kind {
        let header_focused = menu_state.settings_header_focused.unwrap_or(false);
        match k.code {
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab
                if header_focused =>
            {
                let direction: i32 = match k.code {
                    KeyCode::Right | KeyCode::Tab => 1,
                    _ => -1,
                };
                rotate_settings_tab(st, direction);
                return false;
            }
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab
                if !header_focused =>
            {

                let direction: i32 = match k.code {
                    KeyCode::Right | KeyCode::Tab => 1,
                    _ => -1,
                };
                edit_settings_row(st, direction);
                return false;
            }
            KeyCode::Backspace if !header_focused && !menu_state.settings_search_query.is_empty() => {
                menu_state.settings_search_query.pop();
                menu_state.cursor = 0;
                return false;
            }
            KeyCode::Char(' ') if !header_focused && menu_state.settings_search_query.is_empty() => {

                edit_settings_row(st, 1);
                return false;
            }
            KeyCode::Char(c)
                if !header_focused
                    && !k.modifiers.contains(KeyModifiers::CONTROL)
                    && !k.modifiers.contains(KeyModifiers::ALT)
                    && (c.is_alphanumeric() || c == ' ' || c == '-' || c == '_') =>
            {
                menu_state.settings_search_query.push(c);
                menu_state.cursor = 0;
                return false;
            }
            KeyCode::Up if !header_focused && menu_state.cursor == 0 => {
                menu_state.settings_header_focused = Some(true);
                return false;
            }
            KeyCode::Down if header_focused => {
                menu_state.settings_header_focused = Some(false);
                menu_state.cursor = 0;
                return false;
            }
            _ => {}
        }
    }

    if matches!(menu_state.kind, PanelKind::Effort) {
        match k.code {
            KeyCode::Left => {
                menu_state.move_left();
                return false;
            }
            KeyCode::Right => {
                menu_state.move_right();
                return false;
            }
            _ => {}
        }
    }

    if matches!(menu_state.kind, PanelKind::Model)
        && matches!(k.code, KeyCode::Left | KeyCode::Right)
    {
        let dir: i32 = if matches!(k.code, KeyCode::Right) { 1 } else { -1 };
        let cursor_model_id = menu_state
            .options
            .get(menu_state.cursor)
            .map(|o| o.action_id.clone())
            .unwrap_or_default();

        let next_effort: Option<&'static str> =
            crate::models::catalog::by_id(&cursor_model_id).and_then(|m| {
                let real: Vec<&'static str> = m
                    .supported_efforts
                    .iter()
                    .copied()
                    .filter(|l| *l != "auto")
                    .collect();
                if real.len() < 2 {
                    return None;
                }
                let current = st.session.effort_label.unwrap_or(m.default_effort);
                let idx = real.iter().position(|l| *l == current).unwrap_or(0);
                let n = real.len() as i32;
                let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
                Some(real[next_idx])
            });

        let _ = menu_state;
        if let Some(next) = next_effort {
            apply_effort_outcome(st, thinking, next, next);

            let mut fresh =
                menu::OverlayMenu::new_model_with_effort(&st.session.model, st.session.effort_label);
            fresh.cursor = fresh
                .options
                .iter()
                .position(|o| o.action_id == cursor_model_id)
                .unwrap_or(0);
            st.active_menu = Some(fresh);
        }
        return false;
    }
    match k.code {
        KeyCode::Up => menu_state.move_up(),
        KeyCode::Down => menu_state.move_down(),
        KeyCode::Home => menu_state.jump_to_first(),
        KeyCode::End => menu_state.jump_to_last(),
        KeyCode::Enter => {
            let outcome = menu_state.commit_outcome();
            let menu = st.active_menu.take().expect("active_menu present");
            emit_panel_dismiss_anchor(st, &menu, outcome.as_ref());
            if let Some(outcome) = outcome {
                return apply_menu_outcome(st, thinking, outcome);
            }
        }
        _ => {}
    }
    false
}

fn edit_settings_row(st: &mut ConversationState, direction: i32) {
    use crate::config::providers::{self, ProviderId};
    use crate::config::settings::PermissionMode;
    use crate::tui::menu::SettingsRowKind;
    use crate::tui::slash::catalog::PanelKind;

    let (kind, tab) = {
        let Some(m) = st.active_menu.as_ref() else {
            return;
        };
        let tab = match m.kind {
            PanelKind::Settings(t) => t,
            _ => return,
        };
        let Some(row) = m.options.get(m.cursor) else {
            return;
        };
        let Some(kind) = row.settings_kind.clone() else {
            return;
        };
        (kind, tab)
    };

    let dir = if direction == 0 { 1 } else { direction.signum() };
    match kind {
        SettingsRowKind::Provider => {
            let current = st
                .persistence
                .settings
                .default_provider
                .as_deref()
                .and_then(ProviderId::from_slug)
                .unwrap_or(ProviderId::ClaudeCode);
            let next = providers::cycle(current, dir);
            st.persistence.settings.default_provider = Some(next.slug().to_string());
            let default_model = next.default_model();
            if !default_model.is_empty() {
                st.switch_model(default_model);
                st.persistence.settings.default_model = Some(default_model.to_string());
            }
        }
        SettingsRowKind::Model => {
            let provider = st
                .persistence
                .settings
                .default_provider
                .as_deref()
                .and_then(ProviderId::from_slug)
                .unwrap_or(ProviderId::ClaudeCode);
            let list = crate::models::catalog::models_for(provider);
            if list.is_empty() {
                return;
            }
            let idx = list
                .iter()
                .position(|m| m.id == st.session.model.as_str())
                .unwrap_or(0);
            let n = list.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            let next_model = list[next_idx].id;
            st.switch_model(next_model);
            st.persistence.settings.default_model = Some(next_model.to_string());
        }
        SettingsRowKind::PermissionMode => {
            let order = [
                PermissionMode::Default,
                PermissionMode::AcceptEdits,
                PermissionMode::Plan,
                PermissionMode::Yolo,
            ];
            let idx = order
                .iter()
                .position(|m| *m == st.session.permission_mode)
                .unwrap_or(0);
            let n = order.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            st.session.permission_mode = order[next_idx];

        }
        SettingsRowKind::Effort => {

            let levels: &[&str] = crate::models::catalog::by_id(&st.session.model)
                .map(|m| m.supported_efforts)
                .filter(|s| !s.is_empty())
                .unwrap_or(&["auto", "low", "medium", "high", "xhigh", "max"]);
            let current = st.session.effort_label.unwrap_or("auto");
            let idx = levels.iter().position(|l| *l == current).unwrap_or(0);
            let n = levels.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            st.session.effort_label = Some(levels[next_idx]);
            st.persistence.settings.effort_level = Some(levels[next_idx].to_string());
        }
        SettingsRowKind::Bool(id) => {
            let current = match id {
                "auto_compact" => st.persistence.settings.auto_compact.unwrap_or(true),
                "show_tips" => st.persistence.settings.show_tips.unwrap_or(true),
                "verbose" => st.render_verbose,
                _ => return,
            };
            let next = !current;
            match id {
                "auto_compact" => st.persistence.settings.auto_compact = Some(next),
                "show_tips" => st.persistence.settings.show_tips = Some(next),
                "verbose" => {
                    st.render_verbose = next;
                    st.persistence.settings.verbose = Some(next);
                }
                _ => return,
            }
        }
        SettingsRowKind::ReadOnly => return,
    }

    if let Err(e) = persist_session_defaults(st) {
        st.push_system_note(format!("settings write failed: {e}"));
    }

    let prev_cursor = st.active_menu.as_ref().map(|m| m.cursor).unwrap_or(0);
    let prev_header_focused = st
        .active_menu
        .as_ref()
        .and_then(|m| m.settings_header_focused)
        .unwrap_or(false);
    st.active_menu = Some(menu::OverlayMenu::new_settings(tab, st));
    if let Some(m) = st.active_menu.as_mut() {
        m.cursor = prev_cursor.min(m.options.len().saturating_sub(1));
        m.settings_header_focused = Some(prev_header_focused);
    }
}

fn persist_session_defaults(st: &ConversationState) -> Result<()> {
    let provider_id = st
        .persistence
        .settings
        .default_provider
        .clone()
        .unwrap_or_else(|| "anthropic-oauth".to_string());
    let mut pers = crate::state::PersistenceState::new(st.persistence.settings.clone());
    pers.commit_session_defaults(&st.session, &provider_id)
}

fn rotate_settings_tab(st: &mut ConversationState, direction: i32) {
    use crate::tui::slash::catalog::{PanelKind, SettingsTab};
    let current_tab = match st.active_menu.as_ref().map(|m| m.kind) {
        Some(PanelKind::Settings(t)) => t,
        _ => return,
    };
    let order = [SettingsTab::Status, SettingsTab::Config, SettingsTab::Usage];
    let idx = order.iter().position(|t| *t == current_tab).unwrap_or(0);
    let n = order.len() as i32;
    let next_idx = (((idx as i32) + direction).rem_euclid(n)) as usize;
    let next_tab = order[next_idx];

    use crate::tui::slash::panel;
    st.active_menu = None;
    let _ = panel::handle(PanelKind::Settings(next_tab), st);

    if let Some(m) = st.active_menu.as_mut() {
        m.settings_header_focused = Some(true);
    }
}

fn emit_panel_dismiss_anchor(
    st: &mut ConversationState,
    menu: &menu::OverlayMenu,
    outcome: Option<&menu::OverlayMenuOutcome>,
) {
    use crate::tui::slash::catalog::PanelKind;
    let (slash, text) = match menu.kind {

        PanelKind::Rewind => return,
        PanelKind::Model => {
            let chosen = match outcome {
                Some(menu::OverlayMenuOutcome::SetModel { model_id }) => model_id.as_str(),
                _ => st.session.model.as_str(),
            };
            let label = crate::models::catalog::display_name_for(chosen)
                .map(str::to_string)
                .unwrap_or_else(|| chosen.to_string());
            let text = if chosen == st.session.model {

                let suffix = if is_session_default_model(chosen, st) {
                    " (default)"
                } else {
                    ""
                };
                format!("Kept model as {label}{suffix}")
            } else {
                format!("Set model to {label}")
            };
            ("model", text)
        }
        PanelKind::Permissions => match outcome {
            Some(menu::OverlayMenuOutcome::SetPermissionMode { action_id }) => {
                ("permissions", format!("Set permission mode to {action_id}"))
            }
            _ => ("permissions", "Permissions dialog dismissed".to_string()),
        },
        PanelKind::Effort => match outcome {
            Some(menu::OverlayMenuOutcome::SetEffort { label, .. }) => {
                ("effort", format!("Set thinking effort to {label}"))
            }

            _ => ("effort", "Cancelled".to_string()),
        },
        PanelKind::Help => ("help", "Help dialog dismissed".to_string()),

        PanelKind::Settings(tab) => {
            use crate::tui::slash::catalog::SettingsTab;
            let wording = match tab {
                SettingsTab::Config => "Config dialog dismissed",
                SettingsTab::Status => "Status dialog dismissed",
                SettingsTab::Usage => "Status dialog dismissed",
            };
            (tab.slash_name(), wording.to_string())
        }
        PanelKind::Skills => ("skills", "Skills dialog dismissed".to_string()),
        PanelKind::Agents => ("agents", "Agents dialog dismissed".to_string()),
        PanelKind::Mcp => ("mcp", "MCP dialog dismissed".to_string()),
        PanelKind::Hooks => ("hooks", "Hooks dialog dismissed".to_string()),
        PanelKind::Diff => ("diff", "Diff dialog dismissed".to_string()),

        PanelKind::Resume => ("resume", "Resume cancelled".to_string()),

        PanelKind::Tasks => ("tasks", "Background tasks dialog dismissed".to_string()),
    };

    st.push_anchor(slash, "", text, DisplayOrigin::Chrome);
}

fn is_session_default_model(model: &str, st: &ConversationState) -> bool {
    let default = st
        .persistence
        .settings
        .default_model
        .as_deref()
        .unwrap_or_else(|| crate::config::providers::ProviderId::ClaudeCode.default_model());
    model == default
}

fn handle_question_key(k: KeyEvent, st: &mut ConversationState) {
    let Some(q) = st.pending_question.as_mut() else {
        return;
    };
    match k.code {
        KeyCode::Esc => {
            q.resolve(String::new());
            st.pending_question = None;
        }
        KeyCode::Enter => {
            let answer = std::mem::take(&mut q.input);
            q.resolve(answer);
            st.pending_question = None;
        }
        KeyCode::Backspace => q.backspace(),
        KeyCode::Char(c)
            if !k.modifiers.contains(KeyModifiers::CONTROL) =>
        {
            q.push_char(c);
        }
        _ => {}
    }
}

fn handle_agents_panel_key(k: KeyEvent, st: &mut ConversationState) {
    use slash::agents_panel::{handle_key, KeyOutcome};
    let Some(panel) = st.active_agents_panel.as_mut() else {
        return;
    };
    match handle_key(k, panel) {
        KeyOutcome::Dismiss => {
            st.active_agents_panel = None;
            st.push_system_note("⎿ Agents dialog dismissed");
        }
        KeyOutcome::Consumed => {}
    }
}

fn handle_permission_key(k: KeyEvent, st: &mut ConversationState) {
    use crate::permissions::PermissionResponse;
    match k.code {
        KeyCode::Esc => {
            if let Some(mut prompt) = st.pending_permission.take() {
                prompt.resolve(PermissionResponse::Deny);
            }
        }
        KeyCode::Up => {
            if let Some(prompt) = st.pending_permission.as_mut() {
                prompt.move_up();
            }
        }
        KeyCode::Down => {
            if let Some(prompt) = st.pending_permission.as_mut() {
                prompt.move_down();
            }
        }
        KeyCode::Enter => {
            let Some(mut prompt) = st.pending_permission.take() else {
                return;
            };
            let response = prompt.selected_response();
            let rule = session_rule_for(&prompt.tool_name, &prompt.args_preview);
            match response {
                PermissionResponse::AllowSession => {
                    st.session_allowlist.push_rule(rule);
                }
                PermissionResponse::AllowAlways => {
                    st.session_allowlist.push_rule(rule.clone());
                    persist_permission_allow_rule(st, &rule);
                }
                _ => {}
            }
            prompt.resolve(response);
        }
        _ => {}
    }
}

fn persist_permission_allow_rule(st: &mut ConversationState, rule_str: &str) {
    use crate::config::settings::{PermissionRule, PermissionsConfig};
    use crate::permissions::{matcher, MatcherTool};
    let parsed = match matcher::parse(rule_str) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(?e, rule_str, "skip persist: rule unparseable");
            return;
        }
    };
    let tool_name = match parsed.tool {
        MatcherTool::Any => "*".to_string(),
        MatcherTool::Named(n) => n,
    };
    let new_rule = PermissionRule {
        tool_name: Some(tool_name.clone()),
        match_pattern: parsed.pattern.clone(),
        extra: Default::default(),
    };
    let perms = st
        .persistence
        .settings
        .permissions
        .get_or_insert_with(PermissionsConfig::default);
    let already = perms.allow.iter().any(|r| {
        r.tool_name.as_deref() == Some(tool_name.as_str())
            && r.match_pattern == parsed.pattern
    });
    if !already {
        perms.allow.push(new_rule);
    }
    if let Err(e) = persist_session_defaults(st) {
        tracing::warn!(?e, "persist permission rule failed");
    }
}

fn session_rule_for(tool_name: &str, args_preview: &str) -> String {
    if tool_name == "Bash" {
        let cmd = args_preview.trim();
        let prefix = cmd.split_whitespace().next().unwrap_or(cmd);
        if prefix.is_empty() {
            format!("{tool_name}(*)")
        } else {
            format!("{tool_name}({prefix}:*)")
        }
    } else {
        format!("{tool_name}(*)")
    }
}

fn apply_menu_outcome(
    st: &mut ConversationState,
    thinking: &mut Option<ThinkingConfig>,
    outcome: menu::OverlayMenuOutcome,
) -> bool {
    match outcome {
        menu::OverlayMenuOutcome::SetEffort { action_id, label } => {
            apply_effort_outcome(st, thinking, &action_id, &label);
        }
        menu::OverlayMenuOutcome::SetPermissionMode { action_id } => {
            apply_permission_outcome(st, &action_id);
        }
        menu::OverlayMenuOutcome::SetModel { model_id } => {
            apply_model_outcome(st, thinking, &model_id);
        }
    }
    false
}

fn apply_permission_outcome(st: &mut ConversationState, action_id: &str) {
    use crate::config::settings::PermissionMode;
    let mode = match action_id {
        "default" => PermissionMode::Default,
        "acceptEdits" => PermissionMode::AcceptEdits,
        "plan" => PermissionMode::Plan,
        "yolo" => PermissionMode::Yolo,
        _ => {
            st.push_system_note(format!("unknown permission mode: {action_id}"));
            return;
        }
    };
    st.session.permission_mode = mode;
}

fn apply_model_outcome(
    st: &mut ConversationState,
    thinking: &mut Option<ThinkingConfig>,
    model_id: &str,
) {
    let (_base, _thinking) = crate::thinking::parse_suffix(model_id)
        .map(|(m, t)| (m, t))
        .unwrap_or_else(|_| (model_id.to_string(), None));
    st.session.set_model(model_id);

    let current_effort = st.session.effort_label.unwrap_or("auto");
    if !crate::models::catalog::supports_effort(model_id, current_effort) {
        use crate::thinking::ThinkingLevel;
        use std::str::FromStr;
        let next = crate::models::catalog::default_effort_for(model_id);
        if next == "auto" {
            st.session.effort_label = None;
            *thinking = Some(ThinkingConfig::auto());
        } else if let Ok(level) = ThinkingLevel::from_str(next) {
            st.session.effort_label = Some(next);
            *thinking = Some(ThinkingConfig::level(level));
        }
        st.persistence.settings.effort_level = Some(next.to_string());
    }

    st.persistence.settings.default_model = Some(model_id.to_string());
    if let Err(e) = persist_session_defaults(st) {
        st.push_system_note(format!("settings write failed: {e}"));
    }
}

fn apply_effort_outcome(
    st: &mut ConversationState,
    thinking: &mut Option<ThinkingConfig>,
    action_id: &str,
    label: &str,
) {
    use crate::thinking::ThinkingLevel;
    use std::str::FromStr;
    if action_id.eq_ignore_ascii_case("auto") {
        *thinking = Some(ThinkingConfig::auto());
        st.session.effort_label = None;
        st.persistence.settings.effort_level = Some("auto".to_string());
        if let Err(e) = persist_session_defaults(st) {
            st.push_system_note(format!("settings write failed: {e}"));
        }
        return;
    }
    match ThinkingLevel::from_str(action_id) {
        Ok(level) => {
            *thinking = Some(ThinkingConfig::level(level));
            st.session.effort_label = Some(level.as_label());
            st.persistence.settings.effort_level = Some(action_id.to_string());
            if let Err(e) = persist_session_defaults(st) {
                st.push_system_note(format!("settings write failed: {e}"));
            }
        }
        Err(_) => {
            st.push_system_note(format!("unknown effort level: {action_id}"));
        }
    }
    let _ = label;
}

fn spawn_agent_turn(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    _base_model: &str,
    thinking: &Option<ThinkingConfig>,
    tx: &mpsc::Sender<StreamEvent>,
    history: Vec<crate::inference::OpenAiChatMessage>,
) {
    let thinking = *thinking;
    let tx = tx.clone();

    let model = st.session.model.clone();

    let settings = st.persistence.settings.clone();
    let mode = st.session.permission_mode;
    let session_allowlist = st.session_allowlist.clone();

    let provider_for_task = provider.clone();
    let handle = tokio::spawn(async move {
        run_agent_turns(
            provider_for_task,
            model,
            thinking,
            history,
            tx,
            settings,
            mode,
            session_allowlist,
        )
        .await;
    });
    st.turn_task = Some(handle);
}

fn render_completion_line(r: &crate::tasks::TaskRecord) -> String {
    let kind_label = match r.kind {
        crate::tasks::TaskKind::Agent => "Agent",
        crate::tasks::TaskKind::Shell => "Background command",
        crate::tasks::TaskKind::Generic => "Background task",
    };
    let status_phrase = match r.state {
        crate::tasks::TaskState::Completed => "completed",
        crate::tasks::TaskState::Failed => "failed",
        crate::tasks::TaskState::Stopped => "was stopped",

        _ => "ended",
    };
    let exit_suffix = r
        .exit_code
        .filter(|_| matches!(r.kind, crate::tasks::TaskKind::Shell))
        .map(|c| format!(" (exit code {c})"))
        .unwrap_or_default();
    format!("⏺ {kind_label} \"{}\" {status_phrase}{exit_suffix}", r.name)
}

fn drain_pending_inputs(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &Option<ThinkingConfig>,
    provider_id: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    if auto_fire_compact_if_needed(st, provider, base_model, thinking, tx) {
        return true;
    }
    if drain_queue_head_if_any(st, provider, base_model, thinking, provider_id, tx) {
        return true;
    }
    auto_trigger_pending_notifications(st, provider, base_model, thinking, tx)
}

/// Mirrors upstream `autoCompactIfNeeded` gate (minus rapid-refill + failure
/// tracking — post-MVP). Fires a silent compact turn between user turns when
/// token usage crosses the auto-compact threshold, matching the warning chip
/// already shown in the status line.
fn auto_fire_compact_if_needed(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &Option<ThinkingConfig>,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    if st.streaming {
        return false;
    }
    if !st.input.is_empty() {
        return false;
    }
    if !st.persistence.settings.auto_compact.unwrap_or(true) {
        return false;
    }
    if st.session.context_window == 0 {
        return false;
    }
    // Mirror render.rs AUTOCOMPACT_BUFFER_TOKENS — keep in sync manually until
    // that constant is promoted to a shared module.
    let threshold = st.session.context_window.saturating_sub(13_000);
    if threshold == 0 || st.input_tokens < threshold {
        return false;
    }
    if st.history_for_request().is_empty() {
        return false;
    }
    tracing::info!(
        target: "otherside::compact",
        input_tokens = st.input_tokens,
        threshold,
        "auto-fire: crossing auto-compact threshold, dispatching silent summary turn"
    );
    spawn_compact_turn(st, provider, base_model, thinking, tx, "", true);
    true
}

fn auto_trigger_pending_notifications(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &Option<ThinkingConfig>,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    if st.streaming {
        return false;
    }
    if !st.input.is_empty() {
        return false;
    }
    let Some(store) = crate::tasks::store::current_global() else {
        return false;
    };
    if !store.has_pending_notifications() {
        return false;
    }
    let Some(history) = st.submit_auto_notification_turn(&store) else {
        return false;
    };
    tracing::info!(
        target: "otherside::queue",
        history_len = history.len(),
        "auto-trigger: notifications drained, dispatching synthetic turn"
    );
    spawn_agent_turn(st, provider, base_model, thinking, tx, history);
    true
}

fn drain_queue_head_if_any(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &Option<ThinkingConfig>,
    provider_id: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    tracing::info!(
        target: "otherside::queue",
        queue_depth = st.queued_messages.len(),
        streaming = st.streaming,
        "drain_queue_head_if_any entered"
    );
    if !st.consume_queue_head_into_input() {
        tracing::info!(target: "otherside::queue", "queue empty — no drain");
        return false;
    }
    tracing::info!(
        target: "otherside::queue",
        input_len = st.input.len(),
        streaming = st.streaming,
        "queue head consumed; dispatching"
    );

    let exit_signal = dispatch_slash(st, provider, base_model, thinking, tx);
    tracing::info!(
        target: "otherside::queue",
        exit_signal,
        streaming_after = st.streaming,
        "dispatch_slash returned"
    );
    if exit_signal {
        st.push_system_note("queued /exit — press Ctrl+C twice to quit");
    }

    let _ = provider_id;
    true
}

fn dispatch_slash(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &Option<ThinkingConfig>,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    let action = slash::classify(&st.input);
    let outcome = match action {
        slash::SlashAction::Instant { name, args } => {
            slash::instant::handle(&name, &args, st)
        }
        slash::SlashAction::Toggle { name, args } => {
            slash::toggle::handle(&name, &args, st)
        }
        slash::SlashAction::Skill { name, args } => {
            slash::skill::handle(&name, &args, st)
        }
        slash::SlashAction::Anchor { name, args } if name == "compact" => {
            spawn_compact_turn(st, provider, base_model, thinking, tx, &args, false);
            slash::SlashOutcome::Handled
        }
        slash::SlashAction::Anchor { name, args } => {
            slash::anchor::handle(&name, &args, st)
        }
        slash::SlashAction::Panel(pk) => slash::panel::handle(pk, st),
        slash::SlashAction::Auth { name, args } => {
            slash::auth::handle(&name, &args, st)
        }
        slash::SlashAction::Passthrough => {
            submit_current_input(st, provider, base_model, thinking, tx);
            return false;
        }
    };
    match outcome {
        slash::SlashOutcome::Handled => {
            st.input.clear();
            st.autocomplete = None;
            false
        }
        slash::SlashOutcome::ExitApp => true,
        slash::SlashOutcome::SendTurn(body) => {

            let trimmed = st.input.trim();
            let echo = if trimmed.is_empty() {
                String::new()
            } else {
                trimmed.to_string()
            };
            st.pending_wire_override = Some(body);
            st.input = echo;
            submit_current_input(st, provider, base_model, thinking, tx);
            false
        }
    }
}

fn submit_current_input(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &Option<ThinkingConfig>,
    tx: &mpsc::Sender<StreamEvent>,
) {
    let submitted_text = st.input.clone();
    if let Some(history) = st.submit() {
        st.append_record(crate::sessions::Record::UserMessage {
            ts: crate::sessions::record::now_iso(),
            content: submitted_text,
        });
        spawn_agent_turn(st, provider, base_model, thinking, tx, history);
    }
}

fn spawn_compact_turn(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &Option<ThinkingConfig>,
    tx: &mpsc::Sender<StreamEvent>,
    custom_instructions: &str,
    is_auto: bool,
) {
    let history = st.history_for_request();
    if history.is_empty() {
        st.push_system_note("⎿  compact skipped: no history to summarize");
        return;
    }

    st.input.clear();
    st.autocomplete = None;
    st.streaming = true;
    st.push_system_note(if is_auto {
        "✻ Auto-compacting conversation…"
    } else {
        "✻ Compacting conversation…"
    });

    let provider = provider.clone();
    let model = base_model.to_string();
    let thinking_cfg = *thinking;
    let tx = tx.clone();
    let custom = {
        let trimmed = custom_instructions.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    };

    tokio::spawn(async move {
        let result = crate::agent::compact::compact_conversation(
            &*provider,
            &model,
            history,
            custom.as_deref(),
            thinking_cfg,
        )
        .await;
        let event = match result {
            Ok(summary) => StreamEvent::CompactDone { summary, is_auto },
            Err(e) => StreamEvent::CompactFailed { message: e.to_string() },
        };
        let _ = tx.send(event).await;
    });
}

/// Pre-TUI resume picker outcome. Kept narrow on purpose: the full
/// ratatui overlay (upstream `screens/ResumeConversation.tsx`, ~400 LOC)
/// is post-MVP — for now we print a numbered list to stderr and read one
/// line from stdin before dropping into altscreen.
enum PickerOutcome {
    Resume(crate::sessions::SessionId),
    Latest,
    Fresh,
}

fn pick_session_pre_tui(
    cfg_dir: &std::path::Path,
    cwd: &std::path::Path,
) -> PickerOutcome {
    let sessions = match crate::sessions::list_for_cwd(cfg_dir, cwd) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("(otherside) listing sessions failed: {e} — starting fresh");
            return PickerOutcome::Fresh;
        }
    };
    if sessions.is_empty() {
        return PickerOutcome::Fresh;
    }
    if sessions.len() == 1 {
        return PickerOutcome::Resume(sessions[0].id.clone());
    }

    // Cap at 20 rows so the prompt stays terminal-sized. Newest first
    // (matches upstream — newest-first is what users reach for).
    const MAX_ROWS: usize = 20;
    let shown = sessions.iter().take(MAX_ROWS).enumerate();

    eprintln!();
    eprintln!("Resume session — pick one for this directory:");
    for (idx, summary) in shown {
        let when = format_mtime_rel(summary.modified);
        let preview = summary
            .first_user_preview
            .as_deref()
            .unwrap_or("(no user messages yet)");
        let short_id = summary.id.to_string();
        let short = short_id.chars().take(8).collect::<String>();
        eprintln!("  [{:>2}] {when:<16} {short}  {preview}", idx + 1);
    }
    if sessions.len() > MAX_ROWS {
        eprintln!(
            "  … {} older sessions hidden — pass --resume <id> to resume by UUID.",
            sessions.len() - MAX_ROWS,
        );
    }
    eprintln!();
    eprint!("Enter number (1-{}), l=latest, n=fresh, q=quit [n]: ", sessions.len().min(MAX_ROWS));
    use std::io::Write;
    let _ = std::io::stderr().flush();

    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return PickerOutcome::Fresh;
    }
    let choice = line.trim();
    if choice.is_empty() || choice.eq_ignore_ascii_case("n") {
        return PickerOutcome::Fresh;
    }
    if choice.eq_ignore_ascii_case("q") {
        std::process::exit(0);
    }
    if choice.eq_ignore_ascii_case("l") {
        return PickerOutcome::Latest;
    }
    match choice.parse::<usize>() {
        Ok(n) if n >= 1 && n <= sessions.len().min(MAX_ROWS) => {
            PickerOutcome::Resume(sessions[n - 1].id.clone())
        }
        _ => {
            eprintln!("(otherside) unrecognized choice {choice:?} — starting fresh");
            PickerOutcome::Fresh
        }
    }
}

fn format_mtime_rel(mtime: std::time::SystemTime) -> String {
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(mtime)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match secs {
        0..=59 => "just now".to_string(),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3600),
        s if s < 2_592_000 => format!("{}d ago", s / 86_400),
        s => format!("{}w ago", s / 604_800),
    }
}

async fn run_agent_turns(
    provider: Arc<dyn Provider>,
    model: String,
    thinking: Option<ThinkingConfig>,
    initial_history: Vec<crate::inference::OpenAiChatMessage>,
    tx: mpsc::Sender<StreamEvent>,
    settings: crate::config::settings::Settings,
    mode: crate::config::settings::PermissionMode,
    session_allowlist: crate::permissions::RuntimePermissionGrants,
) {
    use crate::agent::{AgentLoop, MAX_AUTO_TURNS};
    use agent_bridge::{TuiDispatcher, TuiObserver};

    let dispatcher = TuiDispatcher {
        tx: tx.clone(),
        settings: Arc::new(settings),
        mode,
        session_allowlist,
    };
    let observer = TuiObserver { tx: tx.clone() };

    let loop_ = AgentLoop {
        model,
        thinking,
        max_turns: MAX_AUTO_TURNS,
        tools: crate::tools::openai_tools(),
        tool_choice: None,
        dispatcher,
        observer,
    };

    let provider = provider.clone();
    let _ = loop_
        .run(initial_history, |req, thinking_cfg| {
            let provider = provider.clone();
            async move { provider.stream(req, thinking_cfg).await }
        })
        .await;

    let _ = tx.send(StreamEvent::Done).await;
}

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    active: bool,
}

impl TerminalGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode().map_err(|e| Error::Tui(format!("raw mode: {e}")))?;
        let mut out = io::stdout();

        execute!(out, EnterAlternateScreen)
            .map_err(|e| Error::Tui(format!("enter altscreen: {e}")))?;
        let backend = CrosstermBackend::new(out);
        let terminal = Terminal::new(backend)
            .map_err(|e| Error::Tui(format!("terminal init: {e}")))?;
        Ok(Self {
            terminal,
            active: true,
        })
    }

    fn restore(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;

        let _ = disable_raw_mode();
        let _ = execute!(
            self.terminal.backend_mut(),
            LeaveAlternateScreen,
            DisableMouseCapture
        );
        let _ = self.terminal.show_cursor();
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

#[cfg(test)]
mod panel_anchor_tests {
    use super::*;
    use crate::tui::menu::{OverlayMenu, OverlayMenuOutcome};
    use crate::tui::slash::catalog::PanelKind;

    fn anchor_lines(st: &ConversationState) -> (String, String) {
        let n = st.messages.len();
        assert!(n >= 2, "expected ≥2 messages, got {n}");
        (
            st.messages[n - 2].content.clone(),
            st.messages[n - 1].content.clone(),
        )
    }

    #[test]
    fn model_dismiss_without_change_reads_kept() {
        let mut st = ConversationState::default();

        st.session.model = "claude-opus-4-7".into();
        let menu = OverlayMenu::new_model(&st.session.model);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/model");
        assert_eq!(anchor, "⎿  Kept model as Opus 4.7");
    }

    #[test]
    fn model_dismiss_with_switch_reads_set() {
        let mut st = ConversationState::default();
        st.session.model = "claude-opus-4-7".into();
        let menu = OverlayMenu::new_model(&st.session.model);
        let outcome = OverlayMenuOutcome::SetModel {
            model_id: "claude-sonnet-4-6".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = anchor_lines(&st);
        assert_eq!(anchor, "⎿  Set model to Sonnet 4.6");
    }

    #[test]
    fn tasks_dismiss_matches_upstream_background_tasks_wording() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Tasks, "Tasks".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/tasks");
        assert_eq!(
            anchor, "⎿  Background tasks dialog dismissed",
            "upstream hardcodes 'Background tasks dialog dismissed' at components/tasks/BackgroundTasksDialog.tsx:268"
        );
    }

    #[test]
    fn help_dismiss_emits_dialog_dismissed() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Help, "Help".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/help");
        assert_eq!(anchor, "⎿  Help dialog dismissed");
    }

    #[test]
    fn permissions_dismiss_esc_emits_dismissed() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_permissions(st.session.permission_mode);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/permissions");
        assert_eq!(anchor, "⎿  Permissions dialog dismissed");
    }

    #[test]
    fn settings_tab_dismiss_wording_per_tab() {

        use crate::tui::slash::catalog::SettingsTab;
        let cases = [
            (SettingsTab::Status, "⎿  Status dialog dismissed"),
            (SettingsTab::Config, "⎿  Config dialog dismissed"),
            (SettingsTab::Usage, "⎿  Status dialog dismissed"),
        ];
        for (tab, expected) in cases {
            let mut st = ConversationState::default();
            let menu = OverlayMenu::new_info(PanelKind::Settings(tab), "_".into(), vec![]);
            emit_panel_dismiss_anchor(&mut st, &menu, None);
            let (echo, anchor) = anchor_lines(&st);
            assert_eq!(echo, format!("/{}", tab.slash_name()));
            assert_eq!(anchor, expected, "tab {:?} dismiss wording", tab);
        }
    }

    #[test]
    fn settings_dismiss_anchor_is_chrome() {

        use crate::tui::slash::catalog::SettingsTab;
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(
            PanelKind::Settings(SettingsTab::Config),
            "_".into(),
            vec![],
        );
        emit_panel_dismiss_anchor(&mut st, &menu, None);

        st.input = "what tests are in state.rs?".into();
        let _ = st.submit();
        let hist = st.history_for_request();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].content, "what tests are in state.rs?");
    }

    #[test]
    fn permissions_dismiss_with_mode_change_emits_set() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_permissions(st.session.permission_mode);
        let outcome = OverlayMenuOutcome::SetPermissionMode {
            action_id: "plan".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = anchor_lines(&st);
        assert_eq!(anchor, "⎿  Set permission mode to plan");
    }

    #[test]
    fn rewind_dismiss_emits_nothing() {

        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Rewind, "Rewind".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        assert!(
            st.messages.is_empty(),
            "rewind dismiss must emit no messages; got {:?}",
            st.messages
        );
    }

    #[test]
    fn resume_dismiss_wording_matches_upstream() {

        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Resume, "Resume".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/resume");
        assert_eq!(anchor, "⎿  Resume cancelled");
    }

    #[test]
    fn effort_dismiss_wording_matches_upstream() {

        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Effort, "Effort".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/effort");
        assert_eq!(anchor, "⎿  Cancelled");
    }

    #[test]
    fn model_dismiss_with_1m_beta_appends_suffix() {

        let mut st = ConversationState::default();
        st.session.model = "claude-opus-4-7[1m]".into();

        assert_eq!(
            crate::config::providers::ProviderId::ClaudeCode.default_model(),
            "claude-opus-4-7[1m]",
            "session-default rule depends on this constant"
        );
        let menu = OverlayMenu::new_model(&st.session.model);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (_, anchor) = anchor_lines(&st);
        assert_eq!(anchor, "⎿  Kept model as Opus 4.7 (1M context) (default)");
    }

    #[test]
    fn anchor_line_uses_double_space_after_symbol() {

        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Help, "Help".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (_, anchor) = anchor_lines(&st);
        assert!(
            anchor.starts_with("⎿  "),
            "anchor must start with `⎿  ` (double space); got {:?}",
            anchor
        );

        let bytes = anchor.as_bytes();

        assert_eq!(&bytes[0..3], [0xE2, 0x8E, 0xBF]);
        assert_eq!(bytes[3], b' ');
        assert_eq!(bytes[4], b' ');
        assert_ne!(
            bytes[5], b' ',
            "no third space allowed; only double-space between ⎿ and the result"
        );
    }
}

#[cfg(test)]
mod settings_edit_tests {
    use super::*;
    use crate::config::settings::PermissionMode;
    use crate::tui::menu::OverlayMenu;
    use crate::tui::slash::catalog::SettingsTab;

    fn focus_row(menu: &mut OverlayMenu, label: &str) {
        menu.cursor = menu
            .options
            .iter()
            .position(|o| o.label == label)
            .unwrap_or_else(|| panic!("row {label:?} missing from Settings Config tab"));
        menu.settings_header_focused = Some(false);
    }

    #[test]
    fn provider_row_cycles_and_switches_model_default() {

        let mut st = ConversationState::default();
        st.session.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Provider");
        }

        edit_settings_row(&mut st, 1);
        assert_eq!(st.persistence.settings.default_provider.as_deref(), Some("codex-oauth"));
        assert_eq!(st.session.model, "gpt-5.4");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("gemini-oauth")
        );
        assert_eq!(st.session.model, "gemini-3.1-pro-preview");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("openai-custom")
        );

        assert_eq!(st.session.model, "gemini-3.1-pro-preview");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("anthropic-oauth")
        );
        assert_eq!(st.session.model, "claude-opus-4-7[1m]");
    }

    #[test]
    fn permission_mode_row_cycles_through_four_modes() {
        let mut st = ConversationState::default();
        st.session.permission_mode = PermissionMode::Default;
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Default permission mode");
        }

        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.permission_mode, PermissionMode::AcceptEdits);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.permission_mode, PermissionMode::Plan);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.permission_mode, PermissionMode::Yolo);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.permission_mode, PermissionMode::Default);
    }

    #[test]
    fn effort_row_cycles_through_six_levels() {
        let mut st = ConversationState::default();
        st.session.effort_label = Some("auto");
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Effort");
        }
        const EXPECTED: &[&str] = &["low", "medium", "high", "xhigh", "max", "auto"];
        for want in EXPECTED {
            edit_settings_row(&mut st, 1);
            assert_eq!(st.session.effort_label, Some(*want));
        }
    }

    #[test]
    fn verbose_row_toggles_on_space() {
        let mut st = ConversationState::default();
        st.render_verbose = false;
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Verbose output");
        }
        edit_settings_row(&mut st, 1);
        assert!(st.render_verbose);
        assert_eq!(st.persistence.settings.verbose, Some(true));
        edit_settings_row(&mut st, 1);
        assert!(!st.render_verbose);
        assert_eq!(st.persistence.settings.verbose, Some(false));
    }

    #[test]
    fn model_row_cycles_through_provider_aliases() {
        let mut st = ConversationState::default();
        st.persistence.settings.default_provider = Some("claude-code".into());
        st.session.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Model");
        }
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.model, "claude-opus-4-7");
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.model, "claude-sonnet-4-6");
        edit_settings_row(&mut st, -1);
        assert_eq!(st.session.model, "claude-opus-4-7");
    }

    #[test]
    fn read_only_row_is_a_no_op() {

        let mut st = ConversationState::default();
        st.session.model = "claude-opus-4-7".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Status, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Model");
        }
        let snap = st.session.model.clone();
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.model, snap);
    }

    #[test]
    fn every_bool_row_toggles_its_settings_field() {
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));

        type Getter = fn(&ConversationState) -> Option<bool>;
        let rows: &[(&str, Getter)] = &[
            ("Auto-compact", |s| s.persistence.settings.auto_compact),
            ("Show tips", |s| s.persistence.settings.show_tips),
        ];
        for (label, getter) in rows {
            if let Some(m) = st.active_menu.as_mut() {
                focus_row(m, label);
            }
            let before = getter(&st).unwrap_or(true);
            edit_settings_row(&mut st, 1);
            let after = getter(&st).expect("bool setting must persist");
            assert_eq!(after, !before, "row {label} failed to toggle");
        }
    }
}
