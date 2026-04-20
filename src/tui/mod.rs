//! Interactive chat TUI.
//!
//! Single-screen ratatui interface with a header, a scrolling message log,
//! and a three-line input box at the bottom. Multi-turn conversation is
//! kept entirely in memory for now — close the TUI and history is gone.
//!
//! # Event loop shape
//!
//! We run three cooperating async primitives:
//!
//! 1. A `crossterm::event::EventStream` that surfaces key events as they
//!    happen (no polling).
//! 2. A `tokio::sync::mpsc` channel carrying chunk / done / error messages
//!    from the inference task.
//! 3. A `tokio::time::interval` that fires periodically so the spinner
//!    animates even when no other event arrives.
//!
//! `tokio::select!` drives all three. State mutations happen on the main
//! task; the network task is pure I/O and only talks back through the
//! channel.
//!
//! # Terminal discipline
//!
//! [`run`] enables raw mode, switches to the alternate screen, hides the
//! cursor, and installs a drop-guard ([`TerminalGuard`]) that reverses
//! every step — even on panic. Forgetting the guard would leave the
//! user's shell in raw mode if anything went wrong, which is a terrible
//! experience to inflict.
//!
//! # Message queue (017 §4)
//!
//! Enter-while-streaming and submit-during-streaming both redirect
//! the input onto [`ConversationState::queued_messages`] instead of
//! dispatching a concurrent request. When the in-flight turn finishes
//! (via `Done`, `Error`, or the sender-drop fallback) the event loop
//! calls [`ConversationState::consume_queue_head_into_input`], and
//! if a head was consumed, re-enters the SendToLlm dispatch path so
//! the queued turn auto-fires. This is inline in the `rx.recv` arm —
//! no background poll, no `queue_head_pending` intermediate field.
//! Up-arrow at empty input pops the queue TAIL for editing (C70).
//!
//! # Open items for future pick-up
//!
//! TODO(hand-off): token accounting for the `context: --%` header slot is
//!   placeholder. Needs a tokenizer and a cache-hit calculator.
//! TODO(hand-off): no session persistence — closing the TUI drops history.
//!   Phase 2 should wire `~/.otherside/sessions/<uuid>.json`.
//! TODO(hand-off): no slash commands (`/help`, `/clear`, `/model`). Input
//!   lines starting with `/` are currently sent verbatim.
//! TODO(hand-off): mouse support disabled. Left intentionally — adding it
//!   requires EnterMouseCapture and selection/click behavior decisions.
//! TODO(hand-off): left/right arrow, Home/End, word-delete are not wired.
//!   Input is append-only plus Backspace. Adding a real text editor means
//!   pulling `tui-textarea` or writing one — defer until the user asks.
//! TODO(hand-off): Ctrl+L clears the screen by forcing a redraw, but does
//!   NOT clear the alternate-screen scrollback. That matches iTerm2 /
//!   tmux semantics; revisit if users find it confusing.
//! TODO(hand-off): error rendering shows only the last error string. No
//!   per-error styling (auth vs network vs rate-limit). Consider wiring
//!   the `Error` variant through once we have more than one failure mode
//!   surfacing in the TUI.

use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event as CtEvent, EventStream, KeyCode, KeyEvent,
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
use crate::inference::OpenAiChatRequest;
use crate::provider::{Provider, Registry};
use crate::thinking::{parse_suffix, ThinkingConfig};

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

/// Event payloads coming from the inference task, pushed onto the mpsc
/// channel. Key events are consumed directly from `EventStream` in the
/// main loop — they don't ride this enum.
///
/// Tool-call lifecycle rides typed `ToolCallStart` / `ToolCallFinish`
/// variants (015). The pair always arrives in order — Start before the
/// dispatcher blocks, Finish after it returns — because
/// [`run_agent_turns`] dispatches tools sequentially. The render layer
/// relies on this ordering to drive the `Running → Ok / Error` state
/// machine.
#[derive(Debug)]
enum StreamEvent {
    /// A chunk from the provider with a non-empty `delta.content`. We
    /// pre-extract the content so the event loop doesn't have to re-unwrap
    /// the OpenAiChunk structure on every tick.
    Delta(String),
    /// The provider finished without error. Full content already delivered
    /// via `Delta`s.
    Done,
    /// Something failed. Carries the formatted message.
    Error(String),
    /// A tool call is about to be dispatched. Arrives BEFORE the
    /// synchronous dispatcher runs so the TUI paints the Running
    /// bullet immediately. Paired with a later `ToolCallFinish`
    /// carrying the same `id`.
    ToolCallStart {
        id: String,
        name: String,
        args: serde_json::Value,
    },
    /// A tool call finished. `result` carries the dispatcher's `Ok`
    /// value or a dispatcher-side `Err` string. `elapsed_ms` is wall
    /// clock between the `Start` send and this `Finish` send.
    ToolCallFinish {
        id: String,
        result: std::result::Result<serde_json::Value, String>,
        elapsed_ms: u64,
    },
    /// Running token counts folded out of the provider stream
    /// (`message_start` / `message_delta` in the Anthropic dialect).
    /// Either side may be `None` — the consumer overwrites whichever
    /// field is `Some` so the most-recent count for each side wins.
    /// Lets the TUI progress line paint `↑ N tokens` in real time
    /// without waiting for the turn to finalize.
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    /// Agent task needs interactive permission approval before it can
    /// dispatch a tool call. The event loop opens a modal overlay and
    /// fires the reply once the user resolves it; the agent task awaits
    /// the oneshot's recv side. Mirrors upstream's `checkPermissions`
    /// modal dialog shape.
    PermissionAsk {
        tool_name: String,
        args_preview: String,
        rule: Option<String>,
        reply: tokio::sync::oneshot::Sender<crate::permissions::PermissionResponse>,
    },
    /// AskUserQuestion tool dispatch — pause the agent turn and route
    /// a free-form text question to the user. The reply oneshot
    /// carries the typed answer (empty string on Esc).
    AskUserQuestion {
        question: String,
        hint: Option<String>,
        reply: tokio::sync::oneshot::Sender<String>,
    },
}

/// Entry point — boot the TUI and run until the user exits.
///
/// `raw_model` is the model id as typed on the command line (or resolved
/// from settings), possibly with a thinking suffix like `(xhigh)`. We
/// parse it here so the suffix rides every turn without re-parsing.
pub async fn run(
    registry: Arc<Registry>,
    raw_model: String,
    provider_id: String,
    initial_permission_mode: crate::config::PermissionMode,
    settings: crate::config::settings::Settings,
) -> Result<()> {
    let provider = registry
        .get(&provider_id)
        .ok_or_else(|| Error::Other(format!("provider {provider_id:?} not registered")))?;

    let (base_model, thinking) = parse_suffix(&raw_model)
        .map_err(|e| Error::Other(format!("invalid model suffix: {e}")))?;

    // Enter the alt-screen + raw mode. The guard reverses this on drop,
    // including on panic — essential because a panicked TUI with raw mode
    // still on leaves the user's shell unusable.
    let mut guard = TerminalGuard::enter()?;
    let res = event_loop(
        &mut guard.terminal,
        provider,
        base_model,
        thinking,
        provider_id,
        initial_permission_mode,
        settings,
    )
    .await;
    guard.restore();
    res
}

/// The core async event loop. Split out from [`run`] so the terminal
/// guard's scope is obvious and the loop itself can be read top-to-bottom.
async fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    provider: Arc<dyn Provider>,
    base_model: String,
    mut thinking: Option<ThinkingConfig>,
    provider_id: String,
    initial_permission_mode: crate::config::PermissionMode,
    settings: crate::config::settings::Settings,
) -> Result<()> {
    let mut st =
        ConversationState::new_for_model_with_mode(&base_model, initial_permission_mode);
    // Seed the render-verbose flag from settings.json so the user's
    // persistent preference survives across sessions. `/verbose`
    // toggles the flag in memory; settings-file writeback is
    // scheduled for spec 007.
    st.render_verbose = settings.verbose.unwrap_or(false);
    // Open a fresh session transcript — fsync'd append-only JSONL per
    // spec 008. Every user / assistant / tool event lands here; the
    // user can replay via `otherside tui --resume <id>` (future). A
    // failure to open (read-only filesystem, missing config dir) drops
    // persistence silently so the TUI stays interactive.
    match crate::config::config_dir() {
        Ok(cfg_dir) => {
            match crate::sessions::open_new(&cfg_dir) {
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
            tracing::warn!(?e, "config dir unavailable; sessions disabled");
        }
    }
    // Seed `thinking` from settings.json::effort_level when the model
    // suffix didn't already pin a level. The suffix wins (per R-105 /
    // R-106 parity) so passing `--model claude-opus-4-7(high)` still
    // trumps settings. Matches upstream precedence: suffix > settings
    // > default.
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
    st.settings = settings;
    // Seed default_provider in settings when null so the file reflects
    // the actual provider the session is using. Future boots see the
    // stamped value and the Provider switcher row renders the right
    // starting point.
    if st.settings.default_provider.is_none() {
        st.settings.default_provider = Some(provider_id.to_string());
    }
    if st.settings.default_model.is_none() {
        st.settings.default_model = Some(st.model.clone());
    }
    if let Err(e) = persist_settings(&st) {
        tracing::warn!(?e, "initial settings write failed");
    }
    // Thread the session's thinking level into the progress-line
    // `thinking with <level> effort` chip. None when no thinking
    // config means the chip is suppressed.
    st.effort_label = thinking
        .as_ref()
        .and_then(|cfg| match cfg.level {
            crate::thinking::ThinkingLevel::Auto | crate::thinking::ThinkingLevel::None => None,
            other => Some(other.as_label()),
        });
    let mut key_stream = EventStream::new();

    // 50 ms = 20 fps — matches upstream's spinner cadence so rotation
    // reads as continuous motion, not a stutter. The same interval
    // doubles as a forced redraw so any state change without a keypress
    // or chunk still paints.
    let mut ticker = tokio::time::interval(Duration::from_millis(50));
    let mut spinner_tick: u64 = 0;

    // The inference task sends StreamEvents through this channel while the
    // main task reads them. Bounded at 1024 — wildly more than any single
    // response should ever produce in flight, and bounded so a runaway
    // stream cannot OOM us.
    let (tx, mut rx) = mpsc::channel::<StreamEvent>(1024);

    // Initial paint so the box appears immediately.
    st.prune_feedback();
    terminal
        .draw(|f| render::render(f, &st, &st.model, &provider_id, spinner_tick))
        .map_err(|e| Error::Other(format!("tui draw: {e}")))?;

    loop {
        tokio::select! {
            // Forced redraw + spinner tick.
            _ = ticker.tick() => {
                spinner_tick = spinner_tick.wrapping_add(1);
                // Deliver any ScheduleWakeup entries whose fire_at has
                // elapsed. Each tick drains the list synchronously —
                // cheap (Vec<WakeupEntry>), bounded by how many wake-
                // ups the model registered.
                for entry in crate::tools::deferred::drain_due_wakeups() {
                    st.push_system_note(format!("⏰ wakeup: {}", entry.message));
                }
            }

            // Chunk / done / error from the inference task.
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
                        // 017 §4 — if the user queued messages while
                        // streaming, pop the head and fire it as the
                        // next turn. No-op when queue empty.
                        drain_queue_head_if_any(
                            &mut st, &provider, &base_model, &thinking, &provider_id, &tx,
                        );
                    }
                    Some(StreamEvent::Error(e)) => {
                        st.fail_stream(e);
                        drain_queue_head_if_any(
                            &mut st, &provider, &base_model, &thinking, &provider_id, &tx,
                        );
                    }
                    Some(StreamEvent::ToolCallStart { id, name, args }) => {
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
                        // Surface the modal overlay — the agent task is
                        // awaiting the reply oneshot. Any existing menu
                        // is forced shut so the permission prompt owns
                        // the screen until the user resolves it.
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
                    None => {
                        // Channel closed without a terminal event — the
                        // task dropped its sender unexpectedly. Treat as
                        // done so we don't leave the UI locked in
                        // streaming mode forever.
                        if st.streaming {
                            st.finish_stream();
                            drain_queue_head_if_any(
                                &mut st, &provider, &base_model, &thinking, &provider_id, &tx,
                            );
                        }
                    }
                }
            }

            // Key / resize / paste events from the terminal.
            maybe = key_stream.next() => {
                match maybe {
                    Some(Ok(CtEvent::Key(k))) => {
                        if handle_key(k, &mut st, &provider, &base_model, &mut thinking, &provider_id, &tx) {
                            break;
                        }
                    }
                    Some(Ok(CtEvent::Resize(_, _))) => {
                        // ratatui picks up the new size on next draw —
                        // nothing to mutate in state.
                    }
                    Some(Ok(_)) => {
                        // Paste / mouse / focus events ignored for MVP.
                    }
                    Some(Err(e)) => {
                        return Err(Error::Other(format!("tui event: {e}")));
                    }
                    None => {
                        // Event stream ended — shouldn't happen while the
                        // terminal is alive, but bail cleanly if it does.
                        break;
                    }
                }
            }
        }

        st.prune_feedback();
        terminal
            .draw(|f| render::render(f, &st, &st.model, &provider_id, spinner_tick))
            .map_err(|e| Error::Other(format!("tui draw: {e}")))?;
    }

    Ok(())
}

/// Dispatch a single key event against the state + (optionally) the
/// inference task. Returns `true` when the user asked to quit, so the
/// outer loop can break cleanly.
fn handle_key(
    k: KeyEvent,
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &mut Option<ThinkingConfig>,
    _provider_id: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    // crossterm emits KeyEventKind::Release on some terminals; we only
    // care about presses. Without this check, every key fires twice on
    // Kitty / Wezterm.
    if k.kind != KeyEventKind::Press {
        return false;
    }

    // A pending AskUserQuestion overlay owns focus until the user
    // submits or cancels the answer — the agent task's oneshot is
    // alive waiting for the reply.
    if st.pending_question.is_some() {
        handle_question_key(k, st);
        return false;
    }

    // A pending permission prompt outranks every other overlay —
    // the agent task is awaiting the oneshot reply, so we gate all
    // keys through the permission handler until it resolves.
    if st.pending_permission.is_some() {
        handle_permission_key(k, st);
        return false;
    }

    // An active overlay menu captures focus first. Every key is
    // routed through the menu handler until it resolves (Enter /
    // Esc). Mirrors upstream `local-jsx` mount shape.
    if st.active_menu.is_some() {
        return handle_menu_key(k, st, thinking);
    }

    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let shift = k.modifiers.contains(KeyModifiers::SHIFT);

    // Any keypress that isn't one of the exit-arming keys disarms the
    // double-press window. Upstream behavior: the hint disappears as
    // soon as the user does anything else.
    let is_exit_arming_key = ctrl
        && matches!(k.code, KeyCode::Char('c') | KeyCode::Char('d'));
    if !is_exit_arming_key {
        st.clear_exit_armed();
    }

    match k.code {
        // Ctrl+C — upstream priority order:
        //   1. if a turn is running, cancel it (do NOT exit);
        //   2. if no turn running and exit arm is active within
        //      the 800ms window, exit;
        //   3. otherwise arm the double-press window so a second
        //      Ctrl+C within 800ms exits.
        KeyCode::Char('c') if ctrl => {
            if st.cancel_stream() {
                // Cancel landed; don't escalate to exit.
            } else if st.exit_confirmed() {
                return true;
            } else {
                st.arm_exit_confirmation("Ctrl+C");
            }
        }

        // Esc — NEVER exits. Dismisses autocomplete, then cancels a
        // running turn, then clears the input buffer. Matches upstream
        // `chat:cancel` semantics at hooks/useCancelRequest.ts.
        KeyCode::Esc => {
            if st.autocomplete.is_some() {
                // Clear the input too — otherwise the leading `/` that
                // triggered the popup lingers, and the next typed slash
                // produces `//<name>` which escapes the dispatcher and
                // reaches the model as a user turn.
                st.close_autocomplete();
                st.clear_input();
            } else if st.streaming {
                st.cancel_stream();
            } else {
                st.clear_input();
            }
            st.clear_exit_armed();
        }

        // Ctrl+D — same double-press semantics as Ctrl+C, but only
        // engages when the input is empty (classic shell behavior).
        KeyCode::Char('d') if ctrl && st.input.is_empty() => {
            if st.exit_confirmed() && st.exit_armed_key == Some("Ctrl+D") {
                return true;
            } else {
                st.arm_exit_confirmation("Ctrl+D");
            }
        }

        // Ctrl+L — force a redraw by doing nothing; the outer loop
        // redraws after every event. (Cheap clear-screen equivalent.)
        KeyCode::Char('l') if ctrl => {}

        // Ctrl+U — kill the whole input line. Standard readline
        // binding; without it users expect Ctrl+U to wipe the
        // buffer and a later Enter submits stale content (bug #76
        // surfaced via parity-tmux: Tab-inserted slash + Ctrl+U +
        // fresh slash concatenated and leaked to the provider).
        KeyCode::Char('u') if ctrl => {
            st.input.clear();
            st.refresh_autocomplete();
        }

        // PgUp / PgDn — scroll the log by a chunk. 10 lines is the
        // de-facto standard across pagers.
        KeyCode::PageUp => st.scroll_up(10),
        KeyCode::PageDown => st.scroll_down(10),

        // Shift+↑ / Shift+↓ — fine-grained scroll. Preserves Up/Down
        // for history navigation while giving keyboard users a way
        // to walk the transcript a line at a time without PageUp's
        // 10-line jump.
        KeyCode::Up if shift => st.scroll_up(1),
        KeyCode::Down if shift => st.scroll_down(1),

        // Ctrl+Home / Ctrl+End — jump to top / bottom of log.
        KeyCode::Home if ctrl => st.scroll_up(10_000),
        KeyCode::End if ctrl => st.scroll_to_bottom(),

        // Up / Down — navigate the autocomplete popup when it's open.
        // When the popup is closed, Up at an empty input restores the
        // most-recent queued message for editing (017 §4 — queue-tail
        // restore, design.md "Decision: Up-arrow restores the queue
        // TAIL"). Up at a non-empty input or with an empty queue is a
        // no-op — leaves room for a future history-recall binding.
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
            }
        }

        // Tab — commit the highlighted slash completion without
        // submitting. Standard autocomplete semantics.
        //
        // Shift+Tab (no popup open) cycles the permission mode per
        // the info-row affordance. Most terminals deliver this as
        // `KeyCode::BackTab`; a handful send `Tab` with the Shift
        // modifier set, so handle both.
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

        // Enter — submit or newline, depending on Shift. When the
        // popup is open, Enter commits the selection and submits the
        // completed slash command. Slash classifier runs before the
        // provider dispatch so local handlers never hit the network.
        //
        // While a stream is in flight, Enter redirects the trimmed
        // input onto `queued_messages` per 017 §4 — we bypass the
        // slash classifier entirely because a local slash handler
        // (e.g. `/clear`) firing mid-turn would mutate state the
        // streaming render path is actively reading. The queue's
        // auto-pop on finish re-runs the Enter path cleanly with
        // streaming == false, which routes the queued text back
        // through classify() at the right moment.
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

        // Backspace — char-at-a-time delete. Shells also bind Ctrl+H to
        // backspace historically; some terminals send it for backspace,
        // others for literal ^H. We honor both.
        KeyCode::Backspace => {
            st.input_backspace();
            st.refresh_autocomplete();
        }
        KeyCode::Char('h') if ctrl => {
            st.input_backspace();
            st.refresh_autocomplete();
        }

        // Plain character — append to input buffer. Accepted while
        // streaming so the user can type the next turn into the queue
        // (017 §4). `refresh_autocomplete` is a no-op while streaming
        // per 011 fidelity, so the popup stays suppressed.
        KeyCode::Char(c) if !ctrl => {
            st.input_push_char(c);
            st.refresh_autocomplete();
        }

        _ => {}
    }

    false
}

// Panel overlay construction moved to `slash::panel::handle` (openspec 001).

/// Route a key event through the active overlay menu. Consumes
/// Enter / Esc to resolve the overlay and the arrow keys to move the
/// cursor. Everything else is swallowed — menus are modal. Returns
/// `true` when the overlay requested an app-wide exit.
fn handle_menu_key(
    k: KeyEvent,
    st: &mut ConversationState,
    thinking: &mut Option<ThinkingConfig>,
) -> bool {
    use crate::tui::slash::catalog::PanelKind;
    if matches!(k.code, KeyCode::Esc) {
        if let Some(menu) = st.active_menu.take() {
            emit_panel_dismiss_anchor(st, &menu, None);
        }
        return false;
    }
    let Some(menu_state) = st.active_menu.as_mut() else {
        return false;
    };
    // Settings panel navigation model (per upstream `Tabs.tsx:183-190`
    // + user clarification 2026-04-20):
    //
    // - `←` / `→` / `Tab` rotate tabs **only** when the header (tab
    //   row) is focused. When a config row is focused, the same keys
    //   belong to the row's value-edit path (toggle bool, cycle enum)
    //   — so they must NOT bleed through and rotate tabs.
    // - `↑` from list top moves focus to the tab row.
    // - `↓` from the tab row moves focus back to the list.
    //
    // Value-edit per-row is wired in openspec 009 (search mode +
    // interactive editing); today the non-header branch is a no-op
    // so we don't accidentally jump tabs from under the user.
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
                // Row focused — cycle the focused setting's value.
                let direction: i32 = match k.code {
                    KeyCode::Right | KeyCode::Tab => 1,
                    _ => -1,
                };
                edit_settings_row(st, direction);
                return false;
            }
            KeyCode::Char(' ') if !header_focused => {
                // Space: toggle bool; advance enum; no-op on read-only.
                edit_settings_row(st, 1);
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
    // Effort picker is a horizontal slider — ←/→ move the cursor
    // (clamped, no wrap) per 014 evidence. Up/Down ignored on Effort;
    // other panels keep vertical navigation.
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
    // Model picker: ←/→ adjusts effort for the currently-highlighted
    // model's supported_efforts set. Mutates session state AND rebuilds
    // the overlay so the colored indicator updates.
    if matches!(menu_state.kind, PanelKind::Model)
        && matches!(k.code, KeyCode::Left | KeyCode::Right)
    {
        let dir: i32 = if matches!(k.code, KeyCode::Right) { 1 } else { -1 };
        let cursor_model_id = menu_state
            .options
            .get(menu_state.cursor)
            .map(|o| o.action_id.clone())
            .unwrap_or_default();
        // Compute next effort BEFORE re-borrowing st via
        // apply_effort_outcome — menu_state holds a mutable borrow of
        // st.active_menu which must drop first.
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
                let current = st.effort_label.unwrap_or(m.default_effort);
                let idx = real.iter().position(|l| *l == current).unwrap_or(0);
                let n = real.len() as i32;
                let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
                Some(real[next_idx])
            });
        // Drop menu_state borrow, then apply + rebuild overlay.
        let _ = menu_state;
        if let Some(next) = next_effort {
            apply_effort_outcome(st, thinking, next, next);
            let mut fresh =
                menu::OverlayMenu::new_model_with_effort(&cursor_model_id, st.effort_label);
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
        _ => {} // modal — swallow everything else
    }
    false
}

/// Mutate the focused Settings row per `direction` (±1). Dispatches
/// on the row's `SettingsRowKind`:
///
/// - `Provider`    — cycle through the 4 provider slugs; side effect
///                   sets `state.model` to the new provider's default.
/// - `PermissionMode` — cycle Default → AcceptEdits → Plan → Yolo.
/// - `Effort`       — cycle auto → low → medium → high → xhigh → max.
/// - `Bool`         — ignore direction, just toggle.
/// - `ReadOnly`     — no-op.
///
/// On any mutation, rebuild the overlay (so the new values render on
/// the next frame) and persist the change to `~/.otherside/settings.json`.
/// Errors on persistence surface via `push_system_note` (Chrome origin
/// per 007 — stays local).
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

    // Direction sign: -1 for Left/BackTab, +1 for Right/Tab/Space.
    // Preserve the sign so backward cycling works — the prior
    // `direction.signum().max(1)` clamp turned every `←` into a
    // forward step (caught by `model_row_cycles_through_provider_aliases`
    // 2026-04-20). Fall back to +1 when the caller passed 0.
    let dir = if direction == 0 { 1 } else { direction.signum() };
    match kind {
        SettingsRowKind::Provider => {
            let current = st
                .settings
                .default_provider
                .as_deref()
                .and_then(ProviderId::from_slug)
                .unwrap_or(ProviderId::ClaudeCode);
            let next = providers::cycle(current, dir);
            st.settings.default_provider = Some(next.slug().to_string());
            let default_model = next.default_model();
            if !default_model.is_empty() {
                st.switch_model(default_model);
                st.settings.default_model = Some(default_model.to_string());
            }
        }
        SettingsRowKind::Model => {
            let provider = st
                .settings
                .default_provider
                .as_deref()
                .and_then(ProviderId::from_slug)
                .unwrap_or(ProviderId::ClaudeCode);
            let list = models_for_provider(provider);
            if list.is_empty() {
                return;
            }
            let idx = list
                .iter()
                .position(|m| *m == st.model.as_str())
                .unwrap_or(0);
            let n = list.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            let next_model = list[next_idx];
            st.switch_model(next_model);
            st.settings.default_model = Some(next_model.to_string());
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
                .position(|m| *m == st.permission_mode)
                .unwrap_or(0);
            let n = order.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            st.permission_mode = order[next_idx];
            st.settings.permission_mode = Some(st.permission_mode);
        }
        SettingsRowKind::Effort => {
            const LEVELS: &[&str] = &["auto", "low", "medium", "high", "xhigh", "max"];
            let current = st.effort_label.unwrap_or("auto");
            let idx = LEVELS.iter().position(|l| *l == current).unwrap_or(0);
            let n = LEVELS.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            st.effort_label = Some(LEVELS[next_idx]);
            st.settings.effort_level = Some(LEVELS[next_idx].to_string());
        }
        SettingsRowKind::Bool(id) => {
            let current = match id {
                "auto_compact" => st.settings.auto_compact.unwrap_or(true),
                "show_tips" => st.settings.show_tips.unwrap_or(true),
                "verbose" => st.render_verbose,
                _ => return,
            };
            let next = !current;
            match id {
                "auto_compact" => st.settings.auto_compact = Some(next),
                "show_tips" => st.settings.show_tips = Some(next),
                "verbose" => {
                    st.render_verbose = next;
                    st.settings.verbose = Some(next);
                }
                _ => return,
            }
        }
        SettingsRowKind::ReadOnly => return,
    }

    // Persist on every mutation — atomic write via `config::write_atomic`.
    if let Err(e) = persist_settings(st) {
        st.push_system_note(format!("settings write failed: {e}"));
    }

    // Rebuild the overlay so the new values render immediately. Keep
    // cursor on the same row (not reset to 0) so editing feels stable.
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

/// Canonical model-alias list per provider — used by the Model row's
/// enum cycle. The first entry is the provider's default (matches
/// `ProviderId::default_model`); subsequent entries walk the known
/// alias list for that provider. openai-custom returns an empty list
/// because the alias is user-supplied; the Model row becomes
/// effectively read-only there.
fn models_for_provider(p: crate::config::providers::ProviderId) -> &'static [&'static str] {
    use crate::config::providers::ProviderId;
    match p {
        ProviderId::ClaudeCode => &[
            "claude-opus-4-7[1m]",
            "claude-opus-4-7",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
        ],
        ProviderId::Codex => &["gpt-5.4", "gpt-5.3", "gpt-5.2", "gpt-4.1"],
        ProviderId::GeminiCli => &[
            "gemini-3.1-pro-preview",
            "gemini-3.1-flash",
            "gemini-2.5-pro",
        ],
        ProviderId::OpenAiCustom => &[],
    }
}

/// Write the current `state.settings` to `~/.otherside/settings.json`
/// atomically. Surfaces the `Err` to the caller for error rendering.
fn persist_settings(st: &ConversationState) -> Result<()> {
    let path = crate::config::settings_path()?;
    let json = serde_json::to_vec_pretty(&st.settings)
        .map_err(|e| crate::error::Error::Config(format!("serialize settings: {e}")))?;
    crate::config::write_atomic(&path, &json, false)?;
    Ok(())
}

/// Rotate the active Settings tab by `direction` (±1). Rebuilds the
/// overlay with the new default tab; carries header_focused=true per
/// upstream `Tabs.tsx:tabs:next` which sets focus as a side effect.
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
    // Rebuild via the same path the initial dispatch uses so the
    // content list matches the new tab. `panel::handle` is
    // idempotent-ish here — we discard the existing menu and remount.
    use crate::tui::slash::panel;
    st.active_menu = None;
    let _ = panel::handle(PanelKind::Settings(next_tab), st);
    // Tab rotation always sets header-focused (upstream side effect).
    if let Some(m) = st.active_menu.as_mut() {
        m.settings_header_focused = Some(true);
    }
}

/// Emit the upstream-style `❯ /<name>` + `⎿ <text>` anchor on panel
/// dismissal. Called for both Esc (no outcome) and Enter (outcome).
/// Wording table transcribed from the 2026-04-19 tmux parity sweep —
/// byte-match on panels we actually captured; neutral dismiss phrasing
/// on panels without a captured reference.
fn emit_panel_dismiss_anchor(
    st: &mut ConversationState,
    menu: &menu::OverlayMenu,
    outcome: Option<&menu::OverlayMenuOutcome>,
) {
    use crate::tui::slash::catalog::PanelKind;
    let (slash, text) = match menu.kind {
        // 010 Gap 1: upstream `/rewind` emits nothing on Esc —
        // the panel just closes. `commands/rewind/index.ts` has
        // no cancel string; `/tmp/parity-20260420-tmux/05-rewind-panel/
        // upstream-dismissed.txt` shows no `⎿ Rewind…` line.
        PanelKind::Rewind => return,
        PanelKind::Model => {
            let chosen = match outcome {
                Some(menu::OverlayMenuOutcome::SetModel { model_id }) => model_id.as_str(),
                _ => st.model.as_str(),
            };
            let label = model_display_label(chosen);
            let text = if chosen == st.model {
                // 010 Gap 4: append ` (default)` when the current
                // model matches the session default, mirroring
                // upstream `renderModelLabel(null)` at
                // `commands/model/model.tsx:316-318`. The ` (1M
                // context)` half is already baked into
                // `model_display_label` for `[1m]` models.
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
            // 010 Gap 3: bare `Cancelled`, not `Effort dialog
            // dismissed`. Live-capture authority:
            // `/tmp/parity-20260420-tmux/07-effort-panel/upstream-dismissed.txt:32`.
            _ => ("effort", "Cancelled".to_string()),
        },
        PanelKind::Help => ("help", "Help dialog dismissed".to_string()),
        // Settings panel dismiss — hardcoded `"Status dialog
        // dismissed"` for all three slashes, matching upstream
        // `Settings.tsx:46` (008 evidence). Slash name picked from
        // the active tab so the user-echo row reads `/<slash>`
        // consistently with what was typed.
        PanelKind::Settings(tab) => (tab.slash_name(), "Status dialog dismissed".to_string()),
        PanelKind::Skills => ("skills", "Skills dialog dismissed".to_string()),
        PanelKind::Agents => ("agents", "Agents dialog dismissed".to_string()),
        PanelKind::Mcp => ("mcp", "MCP dialog dismissed".to_string()),
        PanelKind::Hooks => ("hooks", "Hooks dialog dismissed".to_string()),
        PanelKind::Diff => ("diff", "Diff dialog dismissed".to_string()),
        // 010 Gap 2: upstream emits `Resume cancelled` per
        // `commands/resume/resume.tsx:172-175`.
        PanelKind::Resume => ("resume", "Resume cancelled".to_string()),
    };
    // Every panel dismissal is Chrome — the `⎿  … dialog dismissed`
    // line is local UI breadcrumb only. Upstream marks the same
    // emission with `display: "system"` (R-92 evidence:
    // `reconstructed/2.1.114/source/components/Settings/Settings.tsx:46`)
    // so the history serializer drops it before hitting the wire.
    st.push_anchor(slash, "", text, DisplayOrigin::Chrome);
}

/// Session default per upstream `renderModelLabel(null)` semantics
/// (`commands/model/model.tsx:316-318`). When the current model
/// matches what startup would've picked, the `/model` dismiss
/// anchor appends ` (default)`. Override chain: explicit
/// `settings.default_model` wins; otherwise the `ClaudeCode`
/// provider default (`claude-opus-4-7[1m]`).
fn is_session_default_model(model: &str, st: &ConversationState) -> bool {
    let default = st
        .settings
        .default_model
        .as_deref()
        .unwrap_or_else(|| crate::config::providers::ProviderId::ClaudeCode.default_model());
    model == default
}

/// Map a model id (e.g. `claude-opus-4-7[1m]`) to the human label the
/// panel displays (e.g. `Opus 4.7 with 1M context window`). Falls back
/// to the id itself when no label is registered.
fn model_display_label(model_id: &str) -> String {
    const MODELS: &[(&str, &str)] = &[
        ("claude-opus-4-7", "Opus 4.7"),
        ("claude-opus-4-7[1m]", "Opus 4.7 (1M context)"),
        ("claude-opus-4-6", "Opus 4.6"),
        ("claude-sonnet-4-6", "Sonnet 4.6"),
        ("claude-haiku-4-5", "Haiku 4.5"),
    ];
    MODELS
        .iter()
        .find(|(id, _)| *id == model_id)
        .map(|(_, label)| (*label).to_string())
        .unwrap_or_else(|| model_id.to_string())
}

/// Route a key event through the active AskUserQuestion overlay.
/// Enter fires the reply (current input), Esc fires empty string.
/// Char input accumulates into the answer buffer; Backspace trims.
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

/// Route a key event through the active permission prompt. Esc
/// resolves as `Deny` (safe default — the agent sees a refusal and
/// reports it to the model). Enter fires the currently-selected choice.
fn handle_permission_key(k: KeyEvent, st: &mut ConversationState) {
    use crate::permissions::PermissionResponse;
    let Some(prompt) = st.pending_permission.as_mut() else {
        return;
    };
    match k.code {
        KeyCode::Esc => {
            prompt.resolve(PermissionResponse::Deny);
            st.pending_permission = None;
        }
        KeyCode::Up => prompt.move_up(),
        KeyCode::Down => prompt.move_down(),
        KeyCode::Enter => {
            let response = prompt.selected_response();
            // Record the session-scoped rule BEFORE firing the reply
            // so re-entrant dispatches from the agent task see the
            // new allowlist entry.
            if response == PermissionResponse::AllowSession {
                let rule = session_rule_for(&prompt.tool_name, &prompt.args_preview);
                st.session_allowlist.push_rule(rule);
            }
            prompt.resolve(response);
            st.pending_permission = None;
        }
        _ => {}
    }
}

/// Derive a session-allowlist rule string from `(tool, args_preview)`.
/// For Bash we keep the command prefix up to the first whitespace;
/// for other tools we accept any args (`ToolName(*)`). Mirrors
/// upstream's `buildSessionAllowRule`.
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

/// Apply the overlay's commit outcome to session state. Each variant
/// is side-effectful: `SetEffort` flips the active thinking config,
/// `SetPermissionMode` swaps the posture, `SetModel` switches model.
/// Always returns `false` — app exit is handled by the Instant slash
/// handler, not the overlay path.
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
    st.permission_mode = mode;
}

fn apply_model_outcome(
    st: &mut ConversationState,
    thinking: &mut Option<ThinkingConfig>,
    model_id: &str,
) {
    let (_base, _thinking) = crate::thinking::parse_suffix(model_id)
        .map(|(m, t)| (m, t))
        .unwrap_or_else(|_| (model_id.to_string(), None));
    st.model = model_id.to_string();
    if model_id.to_lowercase().contains("[1m]") {
        st.context_window = 1_000_000;
    } else {
        st.context_window = 200_000;
    }
    // Reconcile effort against the new model's support matrix. When
    // the old effort isn't supported (switching opus xhigh → sonnet
    // which maxes at high, or → haiku which takes only auto), snap
    // to the new model's default_effort AND rebuild `thinking` so
    // the next /v1/messages turn doesn't 400.
    let current_effort = st.effort_label.unwrap_or("auto");
    if !crate::models::catalog::supports_effort(model_id, current_effort) {
        use crate::thinking::ThinkingLevel;
        use std::str::FromStr;
        let next = crate::models::catalog::default_effort_for(model_id);
        if next == "auto" {
            st.effort_label = None;
            *thinking = Some(ThinkingConfig::auto());
        } else if let Ok(level) = ThinkingLevel::from_str(next) {
            st.effort_label = Some(next);
            *thinking = Some(ThinkingConfig::level(level));
        }
        st.settings.effort_level = Some(next.to_string());
    }
    // Persist the user's model choice across sessions.
    st.settings.default_model = Some(model_id.to_string());
    if let Err(e) = persist_settings(st) {
        st.push_system_note(format!("settings write failed: {e}"));
    }
}

/// Translate a committed effort action-id into a new
/// `ThinkingConfig` + progress-line label, persist it to the session,
/// and surface an inline confirmation. `"auto"` disables the explicit
/// level (upstream's `unsetEffortLevel` path).
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
        st.effort_label = None;
        st.settings.effort_level = Some("auto".to_string());
        if let Err(e) = persist_settings(st) {
            st.push_system_note(format!("settings write failed: {e}"));
        }
        return;
    }
    match ThinkingLevel::from_str(action_id) {
        Ok(level) => {
            *thinking = Some(ThinkingConfig::level(level));
            st.effort_label = Some(level.as_label());
            st.settings.effort_level = Some(action_id.to_string());
            if let Err(e) = persist_settings(st) {
                st.push_system_note(format!("settings write failed: {e}"));
            }
        }
        Err(_) => {
            st.push_system_note(format!("unknown effort level: {action_id}"));
        }
    }
    let _ = label;
}

/// `JoinHandle` onto state so Esc / Ctrl+C can abort it. Shared by
/// the Enter dispatch and the queue auto-pop path in the event loop.
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
    // Read the LIVE session model so /model picker commits apply to
    // the NEXT turn. The `_base_model` param is kept for compatibility
    // with existing call sites but ignored — `st.model` is the truth.
    let model = st.model.clone();
    // Snapshot settings + mode at spawn so mid-turn Shift+Tab toggles
    // take effect on the NEXT turn rather than silently mutating an
    // in-flight one. Matches upstream's per-turn permissionMode read.
    let settings = st.settings.clone();
    let mode = st.permission_mode;
    let session_allowlist = st.session_allowlist.clone();
    // Lifetime dance: `provider.stream(req, thinking)` yields a
    // future bound to `&self`. Cloning the Arc gives the spawned
    // task its own owned handle so the borrow lives on the task
    // stack, not here.
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

/// If the queue has a head pending, pop it into `st.input` and fire
/// a fresh turn through the same spawn path as Enter. Called from
/// the event loop right after `finish_stream` / `fail_stream` /
/// channel-drop so a queued message gets its turn without the user
/// having to press Enter again. No-op when the queue is empty.
///
/// The queued content bypasses the slash classifier — it's raw
/// user text that was classified at push time (which is the same
/// conservative stance the Enter-while-streaming path takes:
/// queue storage is verbatim, re-classification on drain). A slash
/// typed during streaming gets its handler fired now, on drain,
/// which is upstream's behavior for queued slashes.
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
    // Run the queued text through the same slash classifier the
    // Enter path uses — preserves local-handler semantics for
    // queued slashes (`/clear`, `/help`, etc.). A queued `/exit`
    // does NOT terminate immediately here; it gets noted so the
    // user can confirm with Ctrl+C instead of losing the queue.
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
    // Silence the unused-parameter warning; the queue-drain path
    // no longer interpolates a default provider id into login/out
    // hints because the auth handler threads its own placeholder.
    let _ = provider_id;
    true
}

/// Classify `st.input` and dispatch it through the per-category slash
/// handlers. Returns `true` when the handler signals app-wide exit
/// (`/exit`). Handlers that produce a user turn route it
/// through `submit` + `spawn_agent_turn` so the provider streams it
/// the same way regular chat does.
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
            // Skill-category slashes ship the SKILL.md body here. We
            // want the model to see the body (wire) but the user's
            // transcript to show only `❯ /<name> [args]` (display).
            // Stash body on state for submit() to pick up, then set
            // the visible input to the `/<name>` echo.
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

/// Submit whatever is in `st.input` as a user turn. Shared tail of
/// the Passthrough / SendTurn paths so both route through the same
/// session-record append + agent spawn.
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

/// Drive the agent loop for one user submission end-to-end. Multi-turn:
/// text stream → if the model asks for tools, dispatch them inline and
/// emit typed `ToolCallStart` / `ToolCallFinish` events so the render
/// layer drives the bullet state machine through `tool_render`; feed
/// the tool results back into history and run another turn, until the
/// model stops asking or the turn cap is hit.
///
/// Tool events are NOT fabricated as `Delta(String)` text — the
/// assistant buffer is strictly assistant-text; tool calls are
/// siblings routed into `ConversationState::active_tool_calls` by
/// the outer event loop (015).
async fn run_agent_turns(
    provider: Arc<dyn Provider>,
    model: String,
    thinking: Option<ThinkingConfig>,
    initial_history: Vec<crate::inference::OpenAiChatMessage>,
    tx: mpsc::Sender<StreamEvent>,
    mut settings: crate::config::settings::Settings,
    mode: crate::config::settings::PermissionMode,
    session_allowlist: crate::permissions::SessionAllowlist,
) {
    use crate::agent::{tool_result_message, Turn, MAX_AUTO_TURNS};
    use crate::inference::{OpenAiChatMessage, OpenAiChatRole};
    use crate::tools;

    let mut history = initial_history;
    let mut turns_taken = 0u32;

    while turns_taken < MAX_AUTO_TURNS {
        turns_taken += 1;
        let req = OpenAiChatRequest {
            model: model.clone(),
            messages: history.clone(),
            stream: Some(true),
            max_tokens: None,
            temperature: None,
            top_p: None,
            stop: None,
            tools: tools::openai_tools(),
            tool_choice: None,
            extra: serde_json::Map::new(),
        };
        let mut stream = match provider.stream(req, thinking).await {
            Ok(s) => s,
            Err(e) => {
                let _ = tx.send(StreamEvent::Error(format_err(&e))).await;
                return;
            }
        };

        let mut turn = Turn::new();
        while let Some(item) = stream.next().await {
            match item {
                Ok(chunk) => {
                    let emitted = turn.fold_chunk(chunk);
                    // Drain any usage folded off this chunk BEFORE the
                    // content delta — small guarantee: the progress
                    // line sees the new token count before the user
                    // perceives the matching text arrive.
                    if let Some(usage) = turn.take_usage() {
                        if tx
                            .send(StreamEvent::Usage {
                                input_tokens: usage.input_tokens,
                                output_tokens: usage.output_tokens,
                            })
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    if let Some(delta) = emitted {
                        if !delta.is_empty() {
                            tracing::trace!(
                                target: "otherside::stream",
                                hop = "tui_delta_send",
                                len = delta.len(),
                                "StreamEvent::Delta dispatching to TUI rx"
                            );
                            if tx.send(StreamEvent::Delta(delta)).await.is_err() {
                                return;
                            }
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(StreamEvent::Error(format_err(&e))).await;
                    return;
                }
            }
        }

        if turn.wants_tool_dispatch() && turn.has_pending_calls() {
            let assistant_text = turn.assistant_text.clone();
            let calls = turn.drain_calls();
            history.push(OpenAiChatMessage {
                role: OpenAiChatRole::Assistant,
                content: assistant_text,
                name: None,
                tool_calls: calls.clone(),
                tool_call_id: None,
            });
            for call in calls {
                let args_value: serde_json::Value =
                    serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| serde_json::Value::String(call.function.arguments.clone()));
                let started = std::time::Instant::now();
                if tx
                    .send(StreamEvent::ToolCallStart {
                        id: call.id.clone(),
                        name: call.function.name.clone(),
                        args: args_value.clone(),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
                let dispatch_outcome = dispatch_with_prompt(
                    &call.function.name,
                    &args_value,
                    &mut settings,
                    mode,
                    &session_allowlist,
                    &tx,
                )
                .await;
                let elapsed_ms = started.elapsed().as_millis() as u64;
                // The tool-result history entry always carries a JSON
                // value — on error, fold the message into a string so
                // the next provider turn sees `{"error": "..."}`-style
                // context instead of a missing block.
                let (history_value, finish_result) = match dispatch_outcome {
                    Ok(v) => (v.clone(), Ok(v)),
                    Err(e) => {
                        let err_string = format!("tool error: {e}");
                        (
                            serde_json::Value::String(err_string.clone()),
                            Err(err_string),
                        )
                    }
                };
                if tx
                    .send(StreamEvent::ToolCallFinish {
                        id: call.id.clone(),
                        result: finish_result,
                        elapsed_ms,
                    })
                    .await
                    .is_err()
                {
                    return;
                }
                history.push(tool_result_message(&call.id, &history_value));
            }
            continue;
        }

        break;
    }

    if turns_taken >= MAX_AUTO_TURNS {
        let _ = tx
            .send(StreamEvent::Delta(format!(
                "\n(auto-turn limit of {MAX_AUTO_TURNS} reached — returning control)\n"
            )))
            .await;
    }
    let _ = tx.send(StreamEvent::Done).await;
}

/// Permission-aware tool dispatch. Mirrors `tools::dispatch_gated` but
/// resolves `Decision::Ask` via an async round-trip through the event
/// loop's modal overlay rather than degrading it to a refusal.
///
/// Flow:
/// 1. Build a session-overlay `Settings` (user perms + session allowlist).
/// 2. `permissions::resolve` → Allow / Deny / Ask.
/// 3. Allow → sync dispatch.
/// 4. Deny → PermissionDenied.
/// 5. Ask → send [`StreamEvent::PermissionAsk`] with a oneshot, await the
///    reply, then dispatch (or refuse) based on the user's choice.
///    `AllowSession` pushes a rule into the session allowlist BEFORE
///    dispatching so subsequent calls in the same turn auto-allow.
async fn dispatch_with_prompt(
    tool_name: &str,
    args: &serde_json::Value,
    settings: &mut crate::config::settings::Settings,
    mode: crate::config::settings::PermissionMode,
    session_allowlist: &crate::permissions::SessionAllowlist,
    tx: &mpsc::Sender<StreamEvent>,
) -> std::result::Result<serde_json::Value, crate::tools::ToolError> {
    use crate::permissions::{self, Decision, PermissionResponse};
    use crate::tools::ToolError;

    // AskUserQuestion needs the event loop to present a text-input
    // overlay. Route it before the permission gate — the tool is
    // always allowed (it IS the user interaction), no rule applies.
    if tool_name == "AskUserQuestion" {
        return ask_user_question_async(args, tx).await;
    }

    // Project args into matcher-shaped input — Bash uses the raw
    // command, every other tool uses the stringified JSON. Without
    // this the session allowlist rule `Bash(ls:*)` never matches
    // the JSON `{"command":"ls /usr"}` the second dispatch sees.
    let input_str = crate::tools::matcher_input_for(tool_name, args);
    // Fold the session allowlist into the settings snapshot so
    // `permissions::resolve` sees it via the normal `permissions.allow`
    // path. Clone the settings locally — we only need the composite
    // for this one resolve call.
    let mut composed = settings.clone();
    overlay_session_allowlist(&mut composed, session_allowlist);
    match permissions::resolve(tool_name, &input_str, &composed, mode) {
        Decision::Allow => crate::tools::dispatch(tool_name, args),
        Decision::Deny { rule } => Err(ToolError::PermissionDenied(rule)),
        Decision::Ask { rule } => {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            let args_preview = preview_args_for_prompt(tool_name, args);
            if tx
                .send(StreamEvent::PermissionAsk {
                    tool_name: tool_name.to_string(),
                    args_preview,
                    rule: rule.clone(),
                    reply: reply_tx,
                })
                .await
                .is_err()
            {
                return Err(ToolError::PermissionDenied(
                    "user interface gone — aborting call".into(),
                ));
            }
            match reply_rx.await {
                Ok(PermissionResponse::Allow) => crate::tools::dispatch(tool_name, args),
                Ok(PermissionResponse::AllowSession) => {
                    // Rule was already pushed to the allowlist by the
                    // event loop's Enter handler. Dispatch immediately.
                    crate::tools::dispatch(tool_name, args)
                }
                Ok(PermissionResponse::Deny) => Err(ToolError::PermissionDenied(
                    rule.unwrap_or_else(|| "user declined".into()),
                )),
                Err(_) => Err(ToolError::PermissionDenied(
                    "permission prompt cancelled".into(),
                )),
            }
        }
    }
}

/// Dispatch AskUserQuestion — surface the TUI overlay, block until
/// the user resolves it, return the answer to the model. An empty
/// answer comes from Esc; the tool result still surfaces it so the
/// model can distinguish "user declined" from "user gave info".
async fn ask_user_question_async(
    args: &serde_json::Value,
    tx: &mpsc::Sender<StreamEvent>,
) -> std::result::Result<serde_json::Value, crate::tools::ToolError> {
    use crate::tools::ToolError;
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("`question` is required".into()))?
        .to_string();
    let hint = args
        .get("hint")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if tx
        .send(StreamEvent::AskUserQuestion {
            question,
            hint,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return Err(ToolError::InvalidArgs(
            "user interface gone — AskUserQuestion aborted".into(),
        ));
    }
    let answer = reply_rx
        .await
        .map_err(|_| ToolError::InvalidArgs("AskUserQuestion cancelled".into()))?;
    Ok(serde_json::json!({
        "answer": answer,
        "declined": answer.is_empty(),
    }))
}

/// Fold the session-scoped allowlist into a settings clone so the
/// shared `permissions::resolve` function treats it like normal
/// allow rules. Kept separate from the settings struct because
/// session rules never write back to disk.
fn overlay_session_allowlist(
    settings: &mut crate::config::settings::Settings,
    session: &crate::permissions::SessionAllowlist,
) {
    use crate::config::settings::{PermissionRule, PermissionsConfig};
    use crate::permissions::{matcher, MatcherTool};
    let rules = session.snapshot();
    if rules.is_empty() {
        return;
    }
    let mut existing = settings.permissions.take().unwrap_or_else(PermissionsConfig::default);
    for raw in rules {
        // Build a PermissionRule from the raw rule string the same
        // way `tests::parse_rule` does — reuse the matcher parser so
        // bad session strings fail identically to bad settings ones.
        let parsed = match matcher::parse(&raw) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let tool_name = match parsed.tool {
            MatcherTool::Any => "*".to_string(),
            MatcherTool::Named(n) => n,
        };
        let rule = PermissionRule {
            tool_name: Some(tool_name),
            match_pattern: parsed.pattern.clone(),
            extra: Default::default(),
        };
        existing.allow.push(rule);
    }
    settings.permissions = Some(existing);
}

/// Build the dim args preview shown on the permission overlay. Mirrors
/// the tool-header convention: Bash surfaces the raw command; others
/// show the primary field. Falls back to a compact JSON stringification.
fn preview_args_for_prompt(tool_name: &str, args: &serde_json::Value) -> String {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    if tool_name == "Bash" {
        if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
            return truncate_preview(cmd, 200);
        }
    }
    for key in ["file_path", "path", "command", "description", "query", "url"] {
        if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
            return truncate_preview(v, 200);
        }
    }
    truncate_preview(&serde_json::to_string(args).unwrap_or_default(), 200)
}

fn truncate_preview(s: &str, cap: usize) -> String {
    let collapsed = s.replace('\n', " ");
    if collapsed.chars().count() <= cap {
        collapsed
    } else {
        let mut out: String = collapsed.chars().take(cap).collect();
        out.push('…');
        out
    }
}

/// Format an error for inline rendering. Keep the message one-line-ish by
/// replacing embedded newlines with spaces; the TUI wraps on the width of
/// the log and long errors scroll horizontally badly otherwise.
fn format_err(e: &Error) -> String {
    let mut s = e.to_string();
    s = s.replace('\n', " ");
    s
}

/// RAII guard that owns the terminal handle plus the raw-mode /
/// alt-screen invariants.
///
/// Entering the TUI and then forgetting to restore the terminal leaves
/// the user's shell in raw mode, which requires `reset` to recover. The
/// guard's `Drop` impl runs even on panic, so as long as we keep this on
/// the stack until `run` returns we stay safe.
struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    active: bool,
}

impl TerminalGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode().map_err(|e| Error::Other(format!("tui raw mode: {e}")))?;
        let mut out = io::stdout();
        // Enable mouse capture so crossterm parses click/scroll bytes
        // as MouseEvent (which the loop discards) instead of letting
        // them leak into the input stream as pseudo-keys.
        execute!(out, EnterAlternateScreen, EnableMouseCapture)
            .map_err(|e| Error::Other(format!("tui enter altscreen: {e}")))?;
        let backend = CrosstermBackend::new(out);
        let terminal = Terminal::new(backend)
            .map_err(|e| Error::Other(format!("tui terminal init: {e}")))?;
        Ok(Self {
            terminal,
            active: true,
        })
    }

    /// Explicit restore so callers can propagate the result. Idempotent —
    /// Drop calls through to here if the caller didn't.
    fn restore(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        // Best-effort cleanup — ignore errors so a restore failure doesn't
        // mask the real error we're trying to return.
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
        // Non-default, non-[1m] model → no suffix.
        st.model = "claude-opus-4-7".into();
        let menu = OverlayMenu::new_model(&st.model);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/model");
        assert_eq!(anchor, "⎿  Kept model as Opus 4.7");
    }

    #[test]
    fn model_dismiss_with_switch_reads_set() {
        let mut st = ConversationState::default();
        st.model = "claude-opus-4-7".into();
        let menu = OverlayMenu::new_model(&st.model);
        let outcome = OverlayMenuOutcome::SetModel {
            model_id: "claude-sonnet-4-6".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = anchor_lines(&st);
        assert_eq!(anchor, "⎿  Set model to Sonnet 4.6");
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
        let menu = OverlayMenu::new_permissions(st.permission_mode);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/permissions");
        assert_eq!(anchor, "⎿  Permissions dialog dismissed");
    }

    #[test]
    fn settings_status_dismiss_wording_hardcoded() {
        // R-92 evidence: upstream `Settings.tsx:46` hardcodes
        // `"Status dialog dismissed"` for all three slashes in the
        // Settings family. Verify /status, /config, /usage all emit
        // the SAME wording (not per-tab variants).
        use crate::tui::slash::catalog::SettingsTab;
        for tab in [SettingsTab::Status, SettingsTab::Config, SettingsTab::Usage] {
            let mut st = ConversationState::default();
            let menu = OverlayMenu::new_info(PanelKind::Settings(tab), "_".into(), vec![]);
            emit_panel_dismiss_anchor(&mut st, &menu, None);
            let (echo, anchor) = anchor_lines(&st);
            assert_eq!(echo, format!("/{}", tab.slash_name()));
            assert_eq!(
                anchor, "⎿  Status dialog dismissed",
                "tab {:?} must dismiss with hardcoded 'Status dialog dismissed' per upstream",
                tab
            );
        }
    }

    #[test]
    fn settings_dismiss_anchor_is_chrome() {
        // 007 + 008 interaction — Settings dismiss must stay local,
        // not ride the wire on the next turn. Chrome origin is the
        // flag that enforces it.
        use crate::tui::slash::catalog::SettingsTab;
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(
            PanelKind::Settings(SettingsTab::Config),
            "_".into(),
            vec![],
        );
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        // Real user turn after dismiss.
        st.input = "what tests are in state.rs?".into();
        let _ = st.submit();
        let hist = st.history_for_request();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].content, "what tests are in state.rs?");
    }

    #[test]
    fn permissions_dismiss_with_mode_change_emits_set() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_permissions(st.permission_mode);
        let outcome = OverlayMenuOutcome::SetPermissionMode {
            action_id: "plan".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = anchor_lines(&st);
        assert_eq!(anchor, "⎿  Set permission mode to plan");
    }

    // 010 tests — panel dismiss wording parity.

    #[test]
    fn rewind_dismiss_emits_nothing() {
        // Gap 1: upstream `/rewind` closes silently on Esc — no
        // anchor, no echo. Evidence:
        // `/tmp/parity-20260420-tmux/05-rewind-panel/upstream-dismissed.txt`.
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
        // Gap 2: upstream `commands/resume/resume.tsx:172-175` emits
        // `onDone('Resume cancelled', { display: 'system' })`.
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Resume, "Resume".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/resume");
        assert_eq!(anchor, "⎿  Resume cancelled");
    }

    #[test]
    fn effort_dismiss_wording_matches_upstream() {
        // Gap 3: upstream emits bare `Cancelled`. Live authority:
        // `/tmp/parity-20260420-tmux/07-effort-panel/upstream-dismissed.txt:32`.
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Effort, "Effort".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (echo, anchor) = anchor_lines(&st);
        assert_eq!(echo, "/effort");
        assert_eq!(anchor, "⎿  Cancelled");
    }

    #[test]
    fn model_dismiss_with_1m_beta_appends_suffix() {
        // Gap 4: session default = `claude-opus-4-7[1m]` via
        // `ProviderId::ClaudeCode.default_model()`. No settings
        // override. Current model matches default → both suffixes
        // compose: `(1M context) (default)`.
        let mut st = ConversationState::default();
        st.model = "claude-opus-4-7[1m]".into();
        // Sanity-check the default provider resolution so a
        // future rename of the provider constant flips this test
        // loudly rather than silently.
        assert_eq!(
            crate::config::providers::ProviderId::ClaudeCode.default_model(),
            "claude-opus-4-7[1m]",
            "session-default rule depends on this constant"
        );
        let menu = OverlayMenu::new_model(&st.model);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (_, anchor) = anchor_lines(&st);
        assert_eq!(anchor, "⎿  Kept model as Opus 4.7 (1M context) (default)");
    }

    #[test]
    fn anchor_line_uses_double_space_after_symbol() {
        // Cross-cutting: every captured upstream anchor uses `⎿  `
        // (double space). Guard against a single-space regression
        // in `state.rs::push_anchor`.
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Help, "Help".into(), vec![]);
        emit_panel_dismiss_anchor(&mut st, &menu, None);
        let (_, anchor) = anchor_lines(&st);
        assert!(
            anchor.starts_with("⎿  "),
            "anchor must start with `⎿  ` (double space); got {:?}",
            anchor
        );
        // A single-space prefix must NOT match (beyond the
        // double-space prefix which naturally matches as a longer
        // prefix). Check character by character: the byte right
        // after `⎿` and the two spaces must be a non-space.
        let bytes = anchor.as_bytes();
        // `⎿` is 3 bytes (U+23BF → 0xE2 0x8E 0xBF). Positions 3
        // and 4 must be spaces; position 5 must not be a space.
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

    /// Place cursor on the Settings row whose `label` matches `label`.
    /// Panic if not found — the test is expressing an intent about a
    /// row the builder MUST produce.
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
        // R-92 evidence: user directive 2026-04-20. Provider cycle
        // carries per-provider default-model side effect.
        let mut st = ConversationState::default();
        st.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Provider");
        }

        edit_settings_row(&mut st, 1);
        assert_eq!(st.settings.default_provider.as_deref(), Some("codex-oauth"));
        assert_eq!(st.model, "gpt-5.4");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.settings.default_provider.as_deref(),
            Some("gemini-oauth")
        );
        assert_eq!(st.model, "gemini-3.1-pro-preview");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.settings.default_provider.as_deref(),
            Some("openai-custom")
        );
        // openai-custom default is empty → state.model stays whatever it was.
        assert_eq!(st.model, "gemini-3.1-pro-preview");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.settings.default_provider.as_deref(),
            Some("anthropic-oauth")
        );
        assert_eq!(st.model, "claude-opus-4-7[1m]");
    }

    #[test]
    fn permission_mode_row_cycles_through_four_modes() {
        let mut st = ConversationState::default();
        st.permission_mode = PermissionMode::Default;
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Default permission mode");
        }

        edit_settings_row(&mut st, 1);
        assert_eq!(st.permission_mode, PermissionMode::AcceptEdits);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.permission_mode, PermissionMode::Plan);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.permission_mode, PermissionMode::Yolo);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.permission_mode, PermissionMode::Default);
    }

    #[test]
    fn effort_row_cycles_through_six_levels() {
        let mut st = ConversationState::default();
        st.effort_label = Some("auto");
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Effort");
        }
        const EXPECTED: &[&str] = &["low", "medium", "high", "xhigh", "max", "auto"];
        for want in EXPECTED {
            edit_settings_row(&mut st, 1);
            assert_eq!(st.effort_label, Some(*want));
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
        assert_eq!(st.settings.verbose, Some(true));
        edit_settings_row(&mut st, 1);
        assert!(!st.render_verbose);
        assert_eq!(st.settings.verbose, Some(false));
    }

    #[test]
    fn model_row_cycles_through_provider_aliases() {
        let mut st = ConversationState::default();
        st.settings.default_provider = Some("claude-code".into());
        st.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Model");
        }
        edit_settings_row(&mut st, 1);
        assert_eq!(st.model, "claude-opus-4-7");
        edit_settings_row(&mut st, 1);
        assert_eq!(st.model, "claude-sonnet-4-6");
        edit_settings_row(&mut st, -1);
        assert_eq!(st.model, "claude-opus-4-7");
    }

    #[test]
    fn read_only_row_is_a_no_op() {
        // Status tab rows are all ReadOnly today. Focus a status row,
        // attempt to edit, assert nothing changes. Guards against a
        // future edit-dispatcher regression that forgets to check the
        // ReadOnly variant.
        let mut st = ConversationState::default();
        st.model = "claude-opus-4-7".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Status, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Model");
        }
        let snap = st.model.clone();
        edit_settings_row(&mut st, 1);
        assert_eq!(st.model, snap);
    }

    #[test]
    fn every_bool_row_toggles_its_settings_field() {
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));

        type Getter = fn(&ConversationState) -> Option<bool>;
        let rows: &[(&str, Getter)] = &[
            ("Auto-compact", |s| s.settings.auto_compact),
            ("Show tips", |s| s.settings.show_tips),
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
