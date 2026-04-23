

use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste,
    Event as CtEvent, EventStream, KeyCode, KeyEvent,
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
pub mod panel_frame;
pub mod progress;
pub mod render;
pub mod slash;
pub mod state;
pub mod tips;
pub mod todos;
pub mod tool_render;
pub mod welcome;

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
    let _ = registry
        .get(&provider_id)
        .ok_or_else(|| Error::Other(format!("provider {provider_id:?} not registered")))?;

    let initial_provider =
        crate::config::providers::ProviderId::from_slug(&provider_id)
            .ok_or_else(|| Error::Other(format!("provider {provider_id:?} not recognized")))?;

    let (base_model, thinking) = parse_suffix(&raw_model)
        .map_err(|e| Error::Other(format!("invalid model suffix: {e}")))?;

    let mut guard = TerminalGuard::enter()?;

    // Zero-cred floor: if no provider has stored credentials, drop the
    // welcome screen in BEFORE `event_loop`. Phase 1 is UI-only — on
    // Enter for an enabled row we log intent and fall through into
    // event_loop anyway (no auth mutation). On Ctrl+C we restore the
    // terminal and exit cleanly. See `docs/ui-panels/welcome-screen.md`.
    if !crate::state::broker::has_any_credentials(&settings) {
        match run_welcome_gate(&mut guard.terminal).await? {
            WelcomeGateOutcome::Proceed(provider) => {
                eprintln!("welcome UI stub: would login to {}", provider.slug());
            }
            WelcomeGateOutcome::Quit => {
                guard.restore();
                return Ok(());
            }
        }
    }

    let res = event_loop(
        &mut guard.terminal,
        registry,
        base_model,
        thinking,
        initial_provider,
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

/// Outcome of the Phase 1 welcome gate. `Proceed` means the user picked
/// an enabled provider row — we log the intent and fall through to the
/// main event loop (UI-only; no auth mutation). `Quit` means Ctrl+C.
enum WelcomeGateOutcome {
    Proceed(crate::config::providers::ProviderId),
    Quit,
}

/// Drive the welcome screen until the user presses Enter on an enabled
/// row or Ctrl+C. Uses a minimal crossterm `EventStream` + ticker loop
/// (no provider stream, no task store) — this runs strictly before any
/// chat state is constructed.
async fn run_welcome_gate(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
) -> Result<WelcomeGateOutcome> {
    use futures::StreamExt;

    let mut state = welcome::WelcomeState::new();
    let mut key_stream = EventStream::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(50));

    terminal
        .draw(|f| welcome::draw(f, f.area(), &state))
        .map_err(|e| Error::Tui(format!("draw welcome: {e}")))?;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // Ticker keeps the loop responsive; no periodic work on
                // the welcome floor yet.
            }
            maybe_evt = key_stream.next() => {
                match maybe_evt {
                    Some(Ok(CtEvent::Key(k))) => {
                        if k.kind != KeyEventKind::Press {
                            continue;
                        }
                        match welcome::handle_key(k, &mut state) {
                            welcome::WelcomeOutcome::Stay => {
                                terminal
                                    .draw(|f| welcome::draw(f, f.area(), &state))
                                    .map_err(|e| Error::Tui(format!("draw welcome: {e}")))?;
                            }
                            welcome::WelcomeOutcome::LoginIntent(p) => {
                                return Ok(WelcomeGateOutcome::Proceed(p));
                            }
                            welcome::WelcomeOutcome::Quit => {
                                return Ok(WelcomeGateOutcome::Quit);
                            }
                        }
                    }
                    Some(Ok(CtEvent::Resize(_, _))) => {
                        terminal
                            .draw(|f| welcome::draw(f, f.area(), &state))
                            .map_err(|e| Error::Tui(format!("draw welcome: {e}")))?;
                    }
                    Some(Ok(_)) => {
                        // Mouse / paste / focus — drop silently like the
                        // main event loop does.
                    }
                    Some(Err(e)) => {
                        return Err(Error::Tui(format!("welcome event stream: {e}")));
                    }
                    None => {
                        return Ok(WelcomeGateOutcome::Quit);
                    }
                }
            }
        }
    }
}

async fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    registry: Arc<Registry>,
    base_model: String,
    mut thinking: Option<ThinkingConfig>,
    initial_provider: crate::config::providers::ProviderId,
    initial_permission_mode: crate::config::PermissionMode,
    settings: crate::config::settings::Settings,
    resume_intent: ResumeIntent,
) -> Result<Option<crate::sessions::SessionId>> {
    let mut st = ConversationState::new_for_model_with_provider(
        &base_model,
        initial_permission_mode,
        initial_provider,
    );

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

    // Install the task-output root (mirrors upstream `_taskOutputDir` in
    // `utils/task/diskOutput.ts:49-54`): `<config_dir>/projects/<slug>/<session-id>`
    // — set once, not rotated mid-session. Background tasks outliving a
    // /clear keep their original paths reachable.
    if let (Ok(cfg_dir), Some(session_id)) = (crate::config::config_dir(), st.session_id.as_ref()) {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let project = crate::sessions::paths::project_dir(&cfg_dir, &cwd);
        let session_root = project.join(session_id.to_string());
        crate::tasks::disk_output::install_root(session_root);
    }

    if thinking.is_none() {
        if let Some(level_str) = settings.effort_level.as_deref() {
            thinking = crate::thinking::config_from_effort_label(level_str);
        }
    }
    st.persistence.settings = settings;

    if st.persistence.settings.default_provider.is_none() {
        st.persistence.settings.default_provider = Some(st.provider_id.slug().to_string());
    }
    if st.persistence.settings.default_model.is_none() {
        st.persistence.settings.default_model = Some(st.session.model.clone());
    }
    if let Err(e) = persist_session_defaults(&st) {
        tracing::warn!(?e, "initial settings write failed");
    }

    st.session.thinking = thinking;
    st.session.effort_label = thinking
        .as_ref()
        .and_then(crate::thinking::label_from_thinking);
    // Align dispatch snapshot with the finalized boot state (settings may
    // have promoted a `None` into an effort level; main.rs installed
    // against `raw_model` suffix only).
    crate::state::dispatch::set_model(st.session.model.clone());
    crate::state::dispatch::set_thinking(thinking);
    let mut key_stream = EventStream::new();

    let mut ticker = tokio::time::interval(Duration::from_millis(50));
    let mut spinner_tick: u64 = 0;

    let (tx, mut rx) = mpsc::channel::<StreamEvent>(1024);

    st.prune_feedback();
    terminal
        .draw(|f| render::render(f, &st, &st.session.model, spinner_tick))
        .map_err(|e| Error::Tui(format!("draw: {e}")))?;

    loop {
        tokio::select! {

            _ = ticker.tick() => {
                spinner_tick = spinner_tick.wrapping_add(1);

                // Keep the /agents panel live: if it's open, re-pull the
                // TaskStore snapshot so a subagent dispatched AFTER the panel
                // opened surfaces immediately, a completion flips the row to
                // the Recent tab, and the per-library `running_count` column
                // stays current. Previously the panel was built ONCE when
                // opened → "No subagents currently running" even when one was.
                if let Some(panel) = st.active_agents_panel.as_mut() {
                    panel.refresh(
                        &st.tasks,
                        crate::agent::subagents::registry::all(),
                    );
                }

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
                    &mut st, &registry, &base_model, &tx,
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
                                provider: Some(st.provider_id.slug().to_string()),
                                model: Some(st.session.model.clone()),
                            });
                        }

                        // Persist lifetime per-(provider, model) usage in
                        // `~/.otherside/projects.json` so /config Usage can
                        // surface a cross-session view. Upstream parity:
                        // `utils/config.ts:95-105` `lastModelUsage`.
                        if let Ok(cwd) = std::env::current_dir() {
                            let provider_slug = st.provider_id.slug().to_string();
                            let model = st.session.model.clone();
                            let input = st.input_tokens;
                            let output = st.output_tokens;
                            let session_id =
                                st.session_id.as_ref().map(|s| s.as_str().to_string());
                            let ts = crate::sessions::record::now_iso();
                            if let Err(e) = crate::config::projects::record_turn_usage(
                                &cwd,
                                &provider_slug,
                                &model,
                                input,
                                output,
                                session_id,
                                ts,
                            ) {
                                tracing::warn!(?e, "projects usage write failed");
                            }
                        }

                        st.finish_stream();

                        drain_pending_inputs(
                            &mut st, &registry, &base_model, &tx,
                        );
                    }
                    Some(StreamEvent::Error(e)) => {
                        st.fail_stream(e);
                        drain_pending_inputs(
                            &mut st, &registry, &base_model, &tx,
                        );
                    }
                    Some(StreamEvent::ToolCallStart { id, name, args }) => {
                        // Upstream hides certain meta tools (ToolSearch, TaskOutput)
                        // from the chat UI via renderToolUseMessage: () => null +
                        // userFacingName: () => ''. They still dispatch — only the
                        // anchor/result rows are suppressed. Session record also
                        // skipped so replays don't resurrect the rows.
                        if crate::tools::is_hidden_tool(&name) {
                            continue;
                        }
                        // If the model emitted assistant text BEFORE the
                        // tool call (refusal prose, "let me check X" prefix,
                        // etc.), `flush_assistant_buffer` moves it onto
                        // `messages[]` for render but LEAVES the transcript
                        // empty — `StreamEvent::Done` then skips the
                        // AssistantMessage record because the buffer is
                        // already drained. Persist the text here so
                        // session.jsonl replays preserve the prose.
                        if !st.current_assistant_buffer.is_empty() {
                            let prose = st.current_assistant_buffer.clone();
                            st.append_record(crate::sessions::Record::AssistantMessage {
                                ts: crate::sessions::record::now_iso(),
                                content: prose,
                                thinking: None,
                                usage: None,
                                provider: Some(st.provider_id.slug().to_string()),
                                model: Some(st.session.model.clone()),
                            });
                        }
                        st.flush_assistant_buffer();
                        st.append_record(crate::sessions::Record::ToolCall {
                            ts: crate::sessions::record::now_iso(),
                            tool_name: name.clone(),
                            args: args.clone(),
                            call_id: id.clone(),
                            provider: Some(st.provider_id.slug().to_string()),
                            model: Some(st.session.model.clone()),
                        });
                        st.begin_tool_call(id, name, args);
                    }
                    Some(StreamEvent::ToolCallFinish { id, result, elapsed_ms }) => {
                        // Hidden-tool finishes never had a begin_tool_call entry
                        // — skip the result render + transcript line too.
                        let tool_name = st
                            .active_tool_calls
                            .iter()
                            .find(|e| e.id == id)
                            .map(|e| e.name.clone());
                        if tool_name.as_deref().is_none() {
                            continue;
                        }
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
                        // Prefer the upstream-shape agent_id we stored on the
                        // record at begin_tool_call time. Falling back to
                        // tool_call_id leaks the Anthropic `toolu_*` prefix
                        // into user-visible chat + breaks the model's expected
                        // `a<16hex>` identifier.
                        let task_id = crate::tasks::TaskId::from_string(tool_call_id.clone());
                        let display_id = st
                            .tasks
                            .get(&task_id)
                            .and_then(|r| r.agent_id.clone())
                            .unwrap_or_else(|| tool_call_id.clone());
                        st.push_system_note(format!(
                            "⎿  Background agent {display_id} completed: {trimmed}"
                        ));
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
                            provider: Some(st.provider_id.slug().to_string()),
                            model: Some(st.session.model.clone()),
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
                            &mut st, &registry, &base_model, &tx,
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
                                &mut st, &registry, &base_model, &tx,
                            );
                        }
                    }
                }
            }

            maybe = key_stream.next() => {
                match maybe {
                    Some(Ok(CtEvent::Key(k))) => {
                        if handle_key(k, &mut st, &registry, &base_model, &tx) {
                            break;
                        }
                    }
                    Some(Ok(CtEvent::Resize(_, _))) => {

                    }
                    Some(Ok(CtEvent::Paste(text))) => {
                        handle_paste(&text, &mut st);
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
            .draw(|f| render::render(f, &st, &st.session.model, spinner_tick))
            .map_err(|e| Error::Tui(format!("draw: {e}")))?;
    }

    Ok(st.session_id.clone())
}

fn handle_key(
    k: KeyEvent,
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
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

    if st.active_tasks_panel.is_some() {
        handle_tasks_panel_key(k, st);
        return false;
    }

    if st.active_agents_panel.is_some() {
        handle_agents_panel_key(k, st);
        return false;
    }

    if st.active_menu.is_some() {
        return handle_menu_key(k, st);
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
                    // Upstream binds `task:background` directly to Ctrl+B
                    // (single press) — see `reconstructed/2.1.117/source/
                    // keybindings/defaultBindings.ts:200` + `BashTool/UI.tsx:46`.
                    // The previous double-tap arming was a misread of upstream
                    // and forced the user to press Ctrl+B twice (user bug
                    // 2026-04-23). Single press fires immediately now.
                    st.ctrl_b_armed_at = None;
                    let _ = st.tasks.background_all_running_foreground();
                    let _ = crate::tools::background_signal::signal_all();
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
            if st.pill_focused {
                st.pill_focused = false;
            } else if st.autocomplete.is_some() {

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
            } else if st.input.is_empty() && st.has_queued_messages() {
                // Bug N: previously gated on `!st.streaming`, so Up during
                // an in-flight turn silently no-oped — exactly when the
                // user queued text and wanted to edit the last item. The
                // queued buffer is independent of streaming state; let
                // Up pull the tail into the input at any time.
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
                && st.active_tasks_panel.is_none()
                && st.active_agents_panel.is_none()
            {
                // Upstream two-stage: first ↓ at prompt bottom focuses the
                // pill (PromptInput.tsx:410-419 decrements coordinatorTaskIndex
                // 0 → -1). Second ↓ or Enter opens `BackgroundTasksDialog`
                // — the task manager, NOT AgentsMenu (parity fix 5,
                // 2026-04-22). `/agents` remains on AgentsPanel.
                if !st.pill_focused {
                    st.pill_focused = true;
                } else {
                    st.pill_focused = false;
                    st.active_tasks_panel = Some(
                        crate::tui::slash::tasks_panel::TasksPanelState::new(
                            &st.tasks,
                        ),
                    );
                }
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
            } else if st.pill_focused
                && !st.streaming
                && st.input.is_empty()
                && st.tasks.any_backgrounded()
                && st.active_tasks_panel.is_none()
                && st.active_agents_panel.is_none()
            {
                // Two-stage pill Enter: open BackgroundTasksDialog (not AgentsMenu).
                st.pill_focused = false;
                st.active_tasks_panel = Some(
                    crate::tui::slash::tasks_panel::TasksPanelState::new(
                        &st.tasks,
                    ),
                );
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
                    registry,
                    base_model,
                    tx,
                ) {
                    return true;
                }
            }
        }

        KeyCode::Backspace => {
            st.pill_focused = false;
            st.input_backspace();
            st.refresh_autocomplete();
        }
        KeyCode::Char('h') if ctrl => {
            st.pill_focused = false;
            st.input_backspace();
            st.refresh_autocomplete();
        }

        KeyCode::Char(c) if !ctrl => {
            st.pill_focused = false;
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
) -> bool {
    use crate::tui::slash::catalog::PanelKind;
    if matches!(k.code, KeyCode::Esc) {
        if let Some(menu) = st.active_menu.as_mut() {
            // Esc in the search region with a non-empty query only clears
            // the filter. A second Esc (empty query) then closes the panel.
            // Esc from tabs or body always closes.
            let in_search = matches!(menu.kind, PanelKind::Settings(_))
                && !menu.settings_header_focused.unwrap_or(false)
                && !menu.settings_body_focused;
            if in_search && !menu.settings_search_query.is_empty() {
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
        let body_focused = menu_state.settings_body_focused;
        // Three-region focus model: tabs (header) | search | body.
        // `header_focused && !body_focused` = tabs.
        // `!header_focused && !body_focused` = search bar (default on open).
        // `!header_focused && body_focused` = body rows.
        match k.code {
            // Tabs: left/right/tab cycle between tabs.
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
            // Body: left/right edit the focused row's value.
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab
                if body_focused =>
            {
                let direction: i32 = match k.code {
                    KeyCode::Right | KeyCode::Tab => 1,
                    _ => -1,
                };
                edit_settings_row(st, direction);
                return false;
            }
            // Search: backspace trims the filter.
            KeyCode::Backspace
                if !header_focused
                    && !body_focused
                    && !menu_state.settings_search_query.is_empty() =>
            {
                menu_state.settings_search_query.pop();
                menu_state.cursor = 0;
                return false;
            }
            // Search: any printable char appends to the filter.
            KeyCode::Char(c)
                if !header_focused
                    && !body_focused
                    && !k.modifiers.contains(KeyModifiers::CONTROL)
                    && !k.modifiers.contains(KeyModifiers::ALT)
                    && (c.is_alphanumeric() || c == ' ' || c == '-' || c == '_') =>
            {
                menu_state.settings_search_query.push(c);
                menu_state.cursor = 0;
                return false;
            }
            // Body: space toggles the focused bool row (legacy affordance).
            KeyCode::Char(' ') if body_focused => {
                edit_settings_row(st, 1);
                return false;
            }
            // Search → tabs.
            KeyCode::Up if !header_focused && !body_focused => {
                menu_state.settings_header_focused = Some(true);
                return false;
            }
            // Body → search when pressing Up at the first visible row.
            KeyCode::Up if body_focused => {
                let lc_query = menu_state.settings_search_query.to_lowercase();
                let first_visible_idx = menu_state
                    .options
                    .iter()
                    .enumerate()
                    .find(|(_, o)| {
                        !o.label.is_empty()
                            && o.action_id != "__line__"
                            && (lc_query.is_empty()
                                || o.label.to_lowercase().contains(&lc_query))
                    })
                    .map(|(i, _)| i);
                if first_visible_idx == Some(menu_state.cursor) {
                    menu_state.settings_body_focused = false;
                    return false;
                }
                menu_state.move_up();
                return false;
            }
            // Tabs → search.
            KeyCode::Down if header_focused => {
                menu_state.settings_header_focused = Some(false);
                menu_state.settings_body_focused = false;
                menu_state.cursor = 0;
                return false;
            }
            // Search → body (Enter or Down): snap cursor to first visible row.
            KeyCode::Down | KeyCode::Enter if !header_focused && !body_focused => {
                let lc_query = menu_state.settings_search_query.to_lowercase();
                let first_visible = menu_state
                    .options
                    .iter()
                    .enumerate()
                    .find(|(_, o)| {
                        !o.label.is_empty()
                            && o.action_id != "__line__"
                            && (lc_query.is_empty()
                                || o.label.to_lowercase().contains(&lc_query))
                    })
                    .map(|(i, _)| i);
                if let Some(idx) = first_visible {
                    menu_state.cursor = idx;
                    menu_state.settings_body_focused = true;
                }
                return false;
            }
            // Body: Down skips hidden rows.
            KeyCode::Down if body_focused => {
                let lc_query = menu_state.settings_search_query.to_lowercase();
                let n = menu_state.options.len();
                for _ in 0..n {
                    menu_state.move_down();
                    let visible = menu_state
                        .options
                        .get(menu_state.cursor)
                        .map(|o| {
                            lc_query.is_empty()
                                || o.label.to_lowercase().contains(&lc_query)
                        })
                        .unwrap_or(false);
                    if visible {
                        break;
                    }
                }
                return false;
            }
            // Body: Enter commits the focused row's edit. Model opens `/model`
            // panel (cycling via Enter silently drops the `[1m]` suffix — parity
            // with upstream which opens a picker here). Other rows cycle like `→`.
            KeyCode::Enter if body_focused => {
                commit_settings_row_enter(st);
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

    if matches!(menu_state.kind, PanelKind::Model) {
        return handle_model_panel_key(k, st);
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
                return apply_menu_outcome(st, outcome);
            }
        }
        _ => {}
    }
    false
}

/// Tabbed `/model` panel key handler. Phase 1 UI-only — Enter on any row
/// fires a `tracing::info!` stub and never mutates session state.
///
/// Keymap:
/// - tabs (focused) + `←/→/Tab` → cycle tab, wraps.
/// - tabs + `↓/Enter` → focus body (row 0).
/// - body + `↑/↓` → walk rows (Authenticated only).
/// - body + `Enter` → log stub intent (set model, logout, login).
/// - Custom unauth + Enter → no-op (per spec).
/// - `Esc` is handled by the generic menu path above, not repeated here.
fn handle_model_panel_key(
    k: KeyEvent,
    st: &mut ConversationState,
) -> bool {
    use crate::config::providers::PROVIDER_ORDER;
    use crate::tui::menu::ModelTabRow;

    let Some(menu_state) = st.active_menu.as_ref() else {
        return false;
    };
    let tabs_focused = menu_state.model_tabs_focused;
    let tab_index = menu_state.model_tab_index;
    let body_cursor = menu_state.model_body_cursor;
    let active_tab_clone = menu_state.active_model_tab().cloned();

    match k.code {
        KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab if tabs_focused => {
            let dir: i32 = match k.code {
                KeyCode::Right | KeyCode::Tab => 1,
                _ => -1,
            };
            let n = PROVIDER_ORDER.len() as i32;
            let next = (((tab_index as i32) + dir).rem_euclid(n)) as usize;
            st.model_panel_tab_index = next;
            st.model_panel_body_cursor = 0;
            rebuild_model_panel(st);
            false
        }
        KeyCode::Down | KeyCode::Enter if tabs_focused => {
            st.model_panel_tabs_focused = false;
            st.model_panel_body_cursor = 0;
            rebuild_model_panel(st);
            false
        }
        KeyCode::Up if !tabs_focused => {
            if body_cursor == 0 {
                st.model_panel_tabs_focused = true;
            } else {
                st.model_panel_body_cursor = body_cursor.saturating_sub(1);
            }
            rebuild_model_panel(st);
            false
        }
        KeyCode::Down if !tabs_focused => {
            let row_count = active_tab_clone
                .as_ref()
                .map(|t| t.rows.len())
                .unwrap_or(0);
            if row_count > 0 {
                let next = (body_cursor + 1).min(row_count.saturating_sub(1));
                st.model_panel_body_cursor = next;
            }
            rebuild_model_panel(st);
            false
        }
        KeyCode::Enter if !tabs_focused => {
            if let Some(tab) = active_tab_clone.as_ref() {
                let provider = tab.provider;
                match tab.rows.get(body_cursor) {
                    Some(ModelTabRow::Model { raw_id, .. }) => {
                        // Commit: switch session provider + model, persist to
                        // settings.default_provider + default_model. Closes
                        // the panel + emits the Set-anchor so the next boot
                        // restores the user's pick (directive 2026-04-23).
                        let new_model = (*raw_id).to_string();
                        if let Err(e) = crate::state::broker::set_active_provider(
                            st,
                            provider,
                        ) {
                            tracing::warn!(?e, "/model commit: provider switch failed");
                        }
                        if let Err(e) = crate::state::broker::set_active_model(st, &new_model) {
                            tracing::warn!(?e, "/model commit: model flush failed");
                        }
                        if let Some(menu) = st.active_menu.take() {
                            let display =
                                crate::models::catalog::display_name_for(&new_model)
                                    .unwrap_or(new_model.as_str());
                            let anchor = format!("Set model to {display}");
                            st.push_anchor(
                                "model",
                                "",
                                anchor,
                                crate::tui::state::DisplayOrigin::Chrome,
                            );
                            let _ = menu;
                        }
                        return false;
                    }
                    Some(ModelTabRow::Logout) => {
                        tracing::info!(
                            target: "otherside::tui::model_panel",
                            ?provider,
                            "/model UI stub: would logout {provider:?}"
                        );
                    }
                    Some(ModelTabRow::LoginCta) => {
                        tracing::info!(
                            target: "otherside::tui::model_panel",
                            ?provider,
                            "/model UI stub: would login {provider:?}"
                        );
                    }
                    // Custom unauth body has no Enter action per spec.
                    Some(ModelTabRow::CustomHint) | None => {}
                }
            }
            false
        }
        _ => false,
    }
}

/// Rebuild the `/model` overlay from canonical fields on `ConversationState`.
/// Mirrors the CycleProvider-rebuild pattern elsewhere — the renderer sees
/// only `&OverlayMenu`, so we rebuild on every state change.
fn rebuild_model_panel(st: &mut ConversationState) {
    let fresh = menu::OverlayMenu::new_model_tabbed(
        &st.session.model,
        &st.persistence.settings,
        st.model_panel_tab_index,
        st.model_panel_tabs_focused,
        st.model_panel_body_cursor,
    );
    st.active_menu = Some(fresh);
}

fn commit_settings_row_enter(st: &mut ConversationState) {
    use crate::config::providers::{ProviderId, PROVIDER_ORDER};
    use crate::tui::menu::SettingsRowKind;
    let enter_kind = st
        .active_menu
        .as_ref()
        .and_then(|m| m.options.get(m.cursor))
        .and_then(|row| row.settings_kind.clone());
    if matches!(enter_kind, Some(SettingsRowKind::Model)) {
        let default_pid = st
            .persistence
            .settings
            .default_provider
            .as_deref()
            .and_then(ProviderId::from_slug)
            .unwrap_or(st.provider_id);
        st.model_panel_tab_index = PROVIDER_ORDER
            .iter()
            .position(|p| *p == default_pid)
            .unwrap_or(0);
        st.model_panel_tabs_focused = true;
        st.model_panel_body_cursor = 0;
        rebuild_model_panel(st);
    } else {
        edit_settings_row(st, 1);
    }
}

fn edit_settings_row(st: &mut ConversationState, direction: i32) {
    use crate::config::providers;
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
            let current = st.provider_id;
            let next = providers::cycle(current, dir);
            if let Err(e) = crate::state::broker::set_active_provider(st, next) {
                tracing::warn!(?e, "/config provider cycle: broker commit failed");
            }
        }
        SettingsRowKind::Model => {
            let provider = st.provider_id;
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
            if let Err(e) = crate::state::broker::set_active_model(st, next_model) {
                tracing::warn!(?e, "/config model cycle: broker write failed");
            }
            // Effort reset when the new model doesn't support the current
            // effort label (e.g. cycling from kimi-for-coding `on` to a
            // haiku row which exposes `low/medium/high`).
            let current_effort = st.session.effort_label.unwrap_or("auto");
            if !crate::models::catalog::supports_effort(next_model, current_effort) {
                let next_effort = crate::models::catalog::default_effort_for(next_model);
                let thinking = crate::thinking::config_from_effort_label(next_effort);
                if let Err(e) = crate::state::broker::set_effort(
                    st,
                    thinking,
                    Some(next_effort.to_string()),
                ) {
                    tracing::warn!(?e, "/config model cycle: effort reset failed");
                }
            }
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
            let next_level = levels[next_idx];
            let thinking = crate::thinking::config_from_effort_label(next_level);
            if let Err(e) = crate::state::broker::set_effort(
                st,
                thinking,
                Some(next_level.to_string()),
            ) {
                tracing::warn!(?e, "/config effort cycle: broker write failed");
            }
        }
        SettingsRowKind::Bool(id) => {
            let current = match id {
                "auto_compact" => st.persistence.settings.auto_compact.unwrap_or(true),
                "show_tips" => st.persistence.settings.show_tips.unwrap_or(true),
                "verbose" => st.render_verbose,
                "prefers_reduced_motion" => st
                    .persistence
                    .settings
                    .prefers_reduced_motion
                    .unwrap_or(false),
                "file_checkpointing_enabled" => st
                    .persistence
                    .settings
                    .file_checkpointing_enabled
                    .unwrap_or(false),
                "auto_connect_ide" => {
                    st.persistence.settings.auto_connect_ide.unwrap_or(false)
                }
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
                "prefers_reduced_motion" => {
                    st.persistence.settings.prefers_reduced_motion = Some(next)
                }
                "file_checkpointing_enabled" => {
                    st.persistence.settings.file_checkpointing_enabled = Some(next)
                }
                "auto_connect_ide" => {
                    st.persistence.settings.auto_connect_ide = Some(next)
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
    let prev_body_focused = st
        .active_menu
        .as_ref()
        .map(|m| m.settings_body_focused)
        .unwrap_or(false);
    let prev_search_query = st
        .active_menu
        .as_ref()
        .map(|m| m.settings_search_query.clone())
        .unwrap_or_default();
    st.active_menu = Some(menu::OverlayMenu::new_settings(tab, st));
    if let Some(m) = st.active_menu.as_mut() {
        m.cursor = prev_cursor.min(m.options.len().saturating_sub(1));
        m.settings_header_focused = Some(prev_header_focused);
        m.settings_body_focused = prev_body_focused;
        m.settings_search_query = prev_search_query;
    }
}

fn persist_session_defaults(st: &ConversationState) -> Result<()> {
    let mut pers = crate::state::PersistenceState::new(st.persistence.settings.clone());
    pers.commit_session_defaults(&st.session, st.provider_id.slug())
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
    // User directive 2026-04-24: "nao mencionar slashs dismisseds na tela
    // de mensagens, fazer isso de maneira silenciosa." Panels close
    // silently; only real DECISIONS (SetEffort, SetPermissionMode) still
    // emit an anchor so the transcript records the user's choice.
    let (slash, text) = match (menu.kind, outcome) {
        (PanelKind::Permissions, Some(menu::OverlayMenuOutcome::SetPermissionMode { action_id })) => {
            ("permissions", format!("Set permission mode to {action_id}"))
        }
        (PanelKind::Effort, Some(menu::OverlayMenuOutcome::SetEffort { label, .. })) => {
            ("effort", format!("Set thinking effort to {label}"))
        }
        _ => return,
    };

    st.push_anchor(slash, "", text, DisplayOrigin::Chrome);
}

/// Handle a bracketed-paste event from the terminal. Inject the full paste
/// content into the active input surface (prompt bar, pending-question, or
/// permission prompt) so Cmd+V / middle-click / drag-drop arrives as one
/// atomic blob instead of a burst of per-character Key events (which would
/// trigger autocomplete / history / key handlers on every char).
///
/// Mouse capture stays on — users who want to copy-paste out with native
/// selection can hold Option (macOS) / Alt (Linux) while dragging; the
/// terminal bypasses mouse capture under that modifier.
fn handle_paste(text: &str, st: &mut ConversationState) {
    if text.is_empty() {
        return;
    }
    if let Some(q) = st.pending_question.as_mut() {
        for c in text.chars() {
            q.push_char(c);
        }
        return;
    }
    if let Some(menu) = st.active_menu.as_mut() {
        // Settings panels carry a filter search query — pastes into an open
        // settings panel extend the filter rather than falling through to
        // the prompt. No-op on panels without a query surface.
        if matches!(menu.kind, crate::tui::slash::catalog::PanelKind::Settings(_)) {
            menu.settings_search_query.push_str(text);
            return;
        }
    }
    // Normalize CRLF → LF so multi-line pastes stay well-formed.
    let normalized: String = text.replace("\r\n", "\n").replace('\r', "\n");
    st.input_push_str(&normalized);
    st.refresh_autocomplete();
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
            // Silent dismiss per user directive 2026-04-24.
            st.active_agents_panel = None;
        }
        KeyOutcome::Consumed => {}
    }
}

fn handle_tasks_panel_key(k: KeyEvent, st: &mut ConversationState) {
    use slash::tasks_panel::{handle_key, KeyOutcome};
    let Some(panel) = st.active_tasks_panel.as_mut() else {
        return;
    };
    // Refresh each tick so row runtime + output grow as tasks run.
    panel.refresh(&st.tasks);
    match handle_key(k, panel) {
        KeyOutcome::Dismiss => {
            st.active_tasks_panel = None;
            st.push_anchor(
                "tasks",
                "",
                "Background tasks dialog dismissed",
                DisplayOrigin::Chrome,
            );
        }
        KeyOutcome::StopFocused => {
            // Upstream `x` from detail: kill the task. Otherside signals
            // the background-cancel channel for the focused tool_use_id,
            // matching the Ctrl+B-handle path. The TaskStore flips the
            // record to Stopped when the runner observes the signal.
            if let Some(tool_use_id) = panel
                .focused_row()
                .and_then(|r| r.tool_use_id.clone())
            {
                let _ = crate::tools::background_signal::signal(&tool_use_id);
            }
            // Leave the panel open — user returns to list with updated state.
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
    outcome: menu::OverlayMenuOutcome,
) -> bool {
    match outcome {
        menu::OverlayMenuOutcome::SetEffort { action_id, label } => {
            apply_effort_outcome(st, &action_id, &label);
        }
        menu::OverlayMenuOutcome::SetPermissionMode { action_id } => {
            apply_permission_outcome(st, &action_id);
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

fn apply_effort_outcome(
    st: &mut ConversationState,
    action_id: &str,
    label: &str,
) {
    use crate::thinking::ThinkingLevel;
    use std::str::FromStr;
    if action_id.eq_ignore_ascii_case("auto") {
        if let Err(e) = crate::state::broker::set_effort(
            st,
            Some(ThinkingConfig::auto()),
            Some("auto".to_string()),
        ) {
            st.push_system_note(format!("settings write failed: {e}"));
        }
        return;
    }
    match ThinkingLevel::from_str(action_id) {
        Ok(level) => {
            if let Err(e) = crate::state::broker::set_effort(
                st,
                Some(ThinkingConfig::level(level)),
                Some(action_id.to_string()),
            ) {
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
    registry: &Arc<Registry>,
    _base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
    history: Vec<crate::inference::OpenAiChatMessage>,
) {
    let provider_id = st.provider_id;
    let Some(provider) = registry.get(provider_id.slug()) else {
        // Anchor shape (`⎿  …`) instead of the `system: …` plain line — this
        // is a terminal turn-level error, not a side note. `push_anchor`
        // emits the `⎿ ` prefix + an empty echo so the line sits under the
        // user's prompt with chrome styling (user directive 2026-04-23).
        st.push_anchor(
            "",
            "",
            format!(
                "provider {} not registered — cannot dispatch turn",
                provider_id.slug()
            ),
            crate::tui::state::DisplayOrigin::Chrome,
        );
        st.streaming = false;
        return;
    };

    let thinking = st.session.thinking;
    let tx = tx.clone();

    let model = st.session.model.clone();

    tracing::info!(
        target: "otherside::dispatch",
        provider = provider_id.slug(),
        model = %model,
        effort = %st.session.effort_label.unwrap_or("auto"),
        permission_mode = ?st.session.permission_mode,
        history_len = history.len(),
        "turn dispatched"
    );

    let settings = st.persistence.settings.clone();
    let mode = st.session.permission_mode;
    let session_allowlist = st.session_allowlist.clone();

    let handle = tokio::spawn(async move {
        run_agent_turns(
            provider,
            model,
            thinking,
            history,
            tx,
            settings,
            mode,
            session_allowlist,
            provider_id,
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
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    if auto_fire_compact_if_needed(st, registry, base_model, tx) {
        return true;
    }
    if drain_queue_head_if_any(st, registry, base_model, tx) {
        return true;
    }
    auto_trigger_pending_notifications(st, registry, base_model, tx)
}

/// Mirrors upstream `autoCompactIfNeeded` gate (minus rapid-refill + failure
/// tracking — post-MVP). Fires a silent compact turn between user turns when
/// token usage crosses the auto-compact threshold, matching the warning chip
/// already shown in the status line.
fn auto_fire_compact_if_needed(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
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
    spawn_compact_turn(st, registry, base_model, tx, "", true);
    true
}

fn auto_trigger_pending_notifications(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
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
    spawn_agent_turn(st, registry, base_model, tx, history);
    true
}

fn drain_queue_head_if_any(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
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

    let exit_signal = dispatch_slash(st, registry, base_model, tx);
    tracing::info!(
        target: "otherside::queue",
        exit_signal,
        streaming_after = st.streaming,
        "dispatch_slash returned"
    );
    if exit_signal {
        st.push_system_note("queued /exit — press Ctrl+C twice to quit");
    }

    true
}

fn dispatch_slash(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
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
            spawn_compact_turn(st, registry, base_model, tx, &args, false);
            slash::SlashOutcome::Handled
        }
        slash::SlashAction::Anchor { name, args } => {
            slash::anchor::handle(&name, &args, st)
        }
        slash::SlashAction::Panel(pk) => slash::panel::handle(pk, st),
        slash::SlashAction::Auth { name, args } => {
            slash::auth::handle(&name, &args, st)
        }
        slash::SlashAction::Unknown { name, args } => {
            let result = if args.is_empty() {
                format!("Unknown skill: {name}")
            } else {
                format!("Unknown skill: {name}\nArgs from unknown skill: {args}")
            };
            st.push_anchor(&name, &args, result, DisplayOrigin::Chrome);
            slash::SlashOutcome::Handled
        }
        slash::SlashAction::Passthrough => {
            submit_current_input(st, registry, base_model, tx);
            return false;
        }
    };

    // Runner resync used to live here (pre-/provider removal). Every slash
    // path today is either (a) provider-neutral (Instant / Toggle / Skill /
    // Anchor / Auth / Unknown / Passthrough) or (b) routes through a panel
    // commit that calls `state::broker::set_active_provider` directly, which
    // owns the runner-update handshake. The post-dispatch hook was therefore
    // dead after `/provider` slash removed in 2026-04-23.
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
            submit_current_input(st, registry, base_model, tx);
            false
        }
    }
}

fn submit_current_input(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) {
    let submitted_text = st.input.clone();
    if let Some(history) = st.submit() {
        st.append_record(crate::sessions::Record::UserMessage {
            ts: crate::sessions::record::now_iso(),
            content: submitted_text,
            provider: Some(st.provider_id.slug().to_string()),
            model: Some(st.session.model.clone()),
        });
        spawn_agent_turn(st, registry, base_model, tx, history);
    }
}

fn spawn_compact_turn(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
    custom_instructions: &str,
    is_auto: bool,
) {
    let history = st.history_for_request();
    if history.is_empty() {
        st.push_system_note("⎿  compact skipped: no history to summarize");
        return;
    }

    let Some(provider) = registry.get(st.provider_id.slug()) else {
        st.push_system_note(format!(
            "compact skipped: provider {:?} not registered",
            st.provider_id.slug()
        ));
        return;
    };

    st.input.clear();
    st.autocomplete = None;
    st.streaming = true;
    st.push_system_note(if is_auto {
        "✻ Auto-compacting conversation…"
    } else {
        "✻ Compacting conversation…"
    });

    let model = base_model.to_string();
    let thinking_cfg = st.session.thinking;
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
    provider_id: crate::config::providers::ProviderId,
) {
    use crate::agent::{AgentLoop, MAX_AUTO_TURNS};
    use agent_bridge::{TuiDispatcher, TuiObserver};

    let dispatcher = TuiDispatcher {
        tx: tx.clone(),
        settings: Arc::new(settings),
        mode,
        session_allowlist,
        provider_id,
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

        // Bracketed paste ON so pasted blocks arrive as a single
        // CtEvent::Paste instead of N key events.
        //
        // Mouse capture intentionally OFF — enabling it suppresses the
        // terminal emulator's native text-selection path (user cannot
        // select/copy chat content). Historical bug T (clicking emitted
        // duplicate Key events) is addressed by bracketed paste + the
        // `Some(Ok(_))` catch-all drop path, not by consuming mouse
        // events wholesale.
        execute!(
            out,
            EnterAlternateScreen,
            EnableBracketedPaste
        )
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
            DisableBracketedPaste,
            LeaveAlternateScreen,
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
    // User directive 2026-04-24: "nao mencionar slashs dismisseds na tela
    // de mensagens, fazer isso de maneira silenciosa." Pure dismisses emit
    // zero messages. Only real decisions (SetEffort, SetPermissionMode)
    // still leave an anchor in the transcript.
    use super::*;
    use crate::tui::menu::{OverlayMenu, OverlayMenuOutcome};
    use crate::tui::slash::catalog::PanelKind;

    fn decision_anchor(st: &ConversationState) -> (String, String) {
        let n = st.messages.len();
        assert!(
            n >= 2,
            "decision anchor pair expected; got {n} messages: {:?}",
            st.messages,
        );
        (
            st.messages[n - 2].content.clone(),
            st.messages[n - 1].content.clone(),
        )
    }

    #[test]
    fn model_panel_dismiss_is_silent() {
        let mut st = ConversationState::default();
        st.session.model = "claude-opus-4-7".into();
        let menu = OverlayMenu::new_model_tabbed(
            &st.session.model,
            &st.persistence.settings,
            0,
            true,
            0,
        );
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        assert!(st.messages.is_empty(), "got {:?}", st.messages);
    }

    #[test]
    fn tasks_panel_dismiss_is_silent() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Tasks, "Tasks".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        assert!(st.messages.is_empty());
    }

    #[test]
    fn help_panel_dismiss_is_silent() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Help, "Help".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        assert!(st.messages.is_empty());
    }

    #[test]
    fn permissions_esc_dismiss_is_silent() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_permissions(st.session.permission_mode);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        assert!(st.messages.is_empty());
    }

    #[test]
    fn settings_tabs_dismiss_is_silent() {
        use crate::tui::slash::catalog::SettingsTab;
        for tab in [SettingsTab::Status, SettingsTab::Config, SettingsTab::Usage] {
            let mut st = ConversationState::default();
            let menu = OverlayMenu::new_info(PanelKind::Settings(tab), "_".into(), vec![]);
            emit_panel_dismiss_anchor(&mut st, &menu, None);
            assert!(st.messages.is_empty(), "tab {tab:?} must be silent");
        }
    }

    #[test]
    fn permissions_dismiss_with_mode_change_emits_set() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_permissions(st.session.permission_mode);
        let outcome = OverlayMenuOutcome::SetPermissionMode {
            action_id: "plan".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = decision_anchor(&st);
        assert_eq!(anchor, "⎿  Set permission mode to plan");
    }

    #[test]
    fn effort_dismiss_with_level_change_emits_set() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Effort, "Effort".into(), vec![]);
        let outcome = OverlayMenuOutcome::SetEffort {
            action_id: "high".into(),
            label: "high".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = decision_anchor(&st);
        assert_eq!(anchor, "⎿  Set thinking effort to high");
    }

    #[test]
    fn agents_panel_esc_is_silent() {
        use crate::agent::subagents::registry;
        use crate::tui::slash::agents_panel::AgentsPanelState;
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

        let mut st = ConversationState::default();
        st.active_agents_panel = Some(AgentsPanelState::new(&st.tasks, registry::all()));
        let esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        handle_agents_panel_key(esc, &mut st);

        assert!(st.active_agents_panel.is_none(), "panel closes on Esc");
        assert!(st.messages.is_empty(), "dismiss must be silent; got {:?}", st.messages);
    }

    #[test]
    fn rewind_dismiss_is_silent() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Rewind, "Rewind".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        assert!(st.messages.is_empty());
    }

    #[test]
    fn resume_dismiss_is_silent() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Resume, "Resume".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        assert!(st.messages.is_empty());
    }

    #[test]
    fn effort_esc_without_change_is_silent() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Effort, "Effort".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        assert!(st.messages.is_empty());
    }

    #[test]
    fn decision_anchor_line_uses_double_space_after_symbol() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_permissions(st.session.permission_mode);
        let outcome = OverlayMenuOutcome::SetPermissionMode {
            action_id: "yolo".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = decision_anchor(&st);
        assert!(anchor.starts_with("⎿  "), "got {anchor:?}");
        let bytes = anchor.as_bytes();
        assert_eq!(&bytes[0..3], [0xE2, 0x8E, 0xBF]);
        assert_eq!(bytes[3], b' ');
        assert_eq!(bytes[4], b' ');
        assert_ne!(bytes[5], b' ');
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
        use crate::config::providers::ProviderId;

        let mut st = ConversationState::default();
        st.session.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Provider");
        }

        edit_settings_row(&mut st, 1);
        assert_eq!(st.provider_id, ProviderId::Codex);
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
            Some("kimi")
        );
        assert_eq!(st.session.model, "kimi-for-coding");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("openai-custom")
        );

        assert_eq!(st.session.model, "kimi-for-coding");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("anthropic-oauth")
        );
        assert_eq!(st.session.model, "claude-opus-4-7[1m]");
    }

    #[test]
    fn effort_row_reflects_new_provider_after_switch() {
        // Regression pin: flipping provider must change the effort cycle
        // space because each provider's model catalog carries its own
        // supported_efforts. Kimi advertises only "auto" — cycling Effort
        // under Kimi must land on "auto", not a Claude-only level.
        use crate::config::providers::ProviderId;
        use crate::config::settings::PermissionMode;

        let mut st = ConversationState::default();
        st.session.permission_mode = PermissionMode::Default;
        st.session.model = "claude-opus-4-7[1m]".into();
        st.provider_id = ProviderId::ClaudeCode;

        let claude_efforts = crate::models::catalog::by_id(&st.session.model)
            .map(|m| m.supported_efforts)
            .unwrap();
        assert!(
            claude_efforts.len() > 1,
            "precondition: opus exposes multi-level effort; got {claude_efforts:?}"
        );

        st.switch_provider(ProviderId::Kimi);
        assert_eq!(st.session.model, "kimi-for-coding");

        let kimi_efforts = crate::models::catalog::by_id(&st.session.model)
            .map(|m| m.supported_efforts)
            .unwrap();
        assert_eq!(
            kimi_efforts,
            &["on", "off"],
            "Kimi reasoning is binary on/off post 2026-04-22 catalog reshape; got {kimi_efforts:?}"
        );

        st.session.effort_label = None;
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Effort");
        }
        edit_settings_row(&mut st, 1);
        assert!(
            matches!(st.session.effort_label, Some("on") | Some("off")),
            "Kimi effort cycle must land on one of on/off; got {:?}",
            st.session.effort_label
        );
    }

    #[test]
    fn paste_event_injects_into_prompt_as_one_blob() {
        let mut st = ConversationState::default();
        super::handle_paste("hello\r\nworld\n!", &mut st);
        assert_eq!(
            st.input, "hello\nworld\n!",
            "CRLF must normalize to LF so multi-line pastes stay well-formed"
        );
    }

    #[test]
    fn paste_image_file_path_injects_as_plain_text_not_stripped() {
        // macOS Terminal / iTerm2 emit the file path as bracketed-paste text
        // when the user drags an image onto the terminal window. Confirm the
        // path is preserved verbatim so downstream (Phase 2: wire-level image
        // content-block wrap) can detect and lift the image.
        let mut st = ConversationState::default();
        super::handle_paste("/Users/me/Desktop/screenshot.png", &mut st);
        assert_eq!(st.input, "/Users/me/Desktop/screenshot.png");

        let mut st2 = ConversationState::default();
        super::handle_paste(
            "file:///Users/me/Downloads/capture.jpeg",
            &mut st2,
        );
        assert_eq!(st2.input, "file:///Users/me/Downloads/capture.jpeg");
    }

    #[test]
    fn paste_empty_string_is_noop() {
        let mut st = ConversationState::default();
        st.input = "keep me".to_string();
        super::handle_paste("", &mut st);
        assert_eq!(st.input, "keep me");
    }

    #[test]
    fn paste_into_settings_panel_extends_search_query_not_prompt() {
        use crate::tui::menu::OverlayMenu;
        use crate::tui::slash::catalog::SettingsTab;
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        super::handle_paste("permiss", &mut st);
        let menu = st.active_menu.as_ref().unwrap();
        assert_eq!(menu.settings_search_query, "permiss");
        assert_eq!(st.input, "", "prompt must stay untouched while settings panel absorbs paste");
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
        // Broker stores `None` for auto/none (label_from_thinking rule); the
        // persistence mirror keeps the literal "auto" for round-trip. UI
        // surfaces display `effort_label.unwrap_or("auto")`.
        const EXPECTED: &[Option<&str>] = &[
            Some("low"),
            Some("medium"),
            Some("high"),
            Some("xhigh"),
            Some("max"),
            None,
        ];
        for want in EXPECTED {
            edit_settings_row(&mut st, 1);
            assert_eq!(st.session.effort_label, *want);
        }
        assert_eq!(st.persistence.settings.effort_level.as_deref(), Some("auto"));
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
    fn enter_on_model_row_opens_model_panel_instead_of_cycling() {
        use crate::tui::slash::catalog::PanelKind;
        let mut st = ConversationState::default();
        st.persistence.settings.default_provider = Some("claude-code".into());
        st.session.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Model");
        }
        commit_settings_row_enter(&mut st);
        assert_eq!(
            st.session.model, "claude-opus-4-7[1m]",
            "session model must not mutate — Enter must open picker, not cycle"
        );
        let kind = st
            .active_menu
            .as_ref()
            .expect("menu still present")
            .kind;
        assert!(
            matches!(kind, PanelKind::Model),
            "Enter must switch overlay to /model panel, got {kind:?}"
        );
    }

    #[test]
    fn enter_on_bool_row_still_toggles() {
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Auto-compact");
        }
        let before = st.persistence.settings.auto_compact.unwrap_or(true);
        commit_settings_row_enter(&mut st);
        let after = st
            .persistence
            .settings
            .auto_compact
            .expect("bool setting persists");
        assert_eq!(after, !before, "non-Model Enter must still cycle");
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
    fn edit_preserves_body_focus_and_search_query() {
        // User bug 2026-04-23: toggling a bool row kicked focus back to the
        // search region, so the user had to navigate down again on every
        // change. `edit_settings_row` rebuilds the menu with fresh
        // `OverlayMenu::new_settings` (which defaults body_focused=false,
        // query=""); the rebuild must preserve both.
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            m.settings_body_focused = true;
            m.settings_search_query = "auto".into();
            focus_row(m, "Auto-compact");
        }
        let cursor_before = st.active_menu.as_ref().unwrap().cursor;
        edit_settings_row(&mut st, 1);
        let m = st.active_menu.as_ref().expect("menu still present");
        assert!(
            m.settings_body_focused,
            "body focus must survive edit — user bug 2026-04-23"
        );
        assert_eq!(
            m.settings_search_query, "auto",
            "search query must survive edit"
        );
        assert_eq!(
            m.cursor, cursor_before,
            "cursor row must not jump on edit"
        );
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
