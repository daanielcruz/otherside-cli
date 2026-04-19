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
    DisableMouseCapture, Event as CtEvent, EventStream, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers,
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
pub mod progress;
pub mod render;
pub mod slash_catalog;
pub mod slashes;
pub mod state;
pub mod tips;
pub mod todos;
pub mod tool_render;

use state::ConversationState;

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
    thinking: Option<ThinkingConfig>,
    provider_id: String,
    initial_permission_mode: crate::config::PermissionMode,
) -> Result<()> {
    let mut st =
        ConversationState::new_for_model_with_mode(&base_model, initial_permission_mode);
    // Thread the session's thinking level into the progress-line
    // `thinking with <level> effort` chip. None when no thinking
    // config means the chip is suppressed.
    st.effort_label = thinking.as_ref().map(|cfg| cfg.level.as_label());
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
    terminal
        .draw(|f| render::render(f, &st, &base_model, &provider_id, spinner_tick))
        .map_err(|e| Error::Other(format!("tui draw: {e}")))?;

    loop {
        tokio::select! {
            // Forced redraw + spinner tick.
            _ = ticker.tick() => {
                spinner_tick = spinner_tick.wrapping_add(1);
            }

            // Chunk / done / error from the inference task.
            maybe = rx.recv() => {
                match maybe {
                    Some(StreamEvent::Delta(s)) => {
                        st.append_stream_delta(&s);
                    }
                    Some(StreamEvent::Done) => {
                        st.finish_stream();
                    }
                    Some(StreamEvent::Error(e)) => {
                        st.fail_stream(e);
                    }
                    Some(StreamEvent::ToolCallStart { id, name, args }) => {
                        st.begin_tool_call(id, name, args);
                    }
                    Some(StreamEvent::ToolCallFinish { id, result, elapsed_ms }) => {
                        st.finish_tool_call(&id, result, elapsed_ms);
                    }
                    None => {
                        // Channel closed without a terminal event — the
                        // task dropped its sender unexpectedly. Treat as
                        // done so we don't leave the UI locked in
                        // streaming mode forever.
                        if st.streaming {
                            st.finish_stream();
                        }
                    }
                }
            }

            // Key / resize / paste events from the terminal.
            maybe = key_stream.next() => {
                match maybe {
                    Some(Ok(CtEvent::Key(k))) => {
                        if handle_key(k, &mut st, &provider, &base_model, &thinking, &provider_id, &tx) {
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

        terminal
            .draw(|f| render::render(f, &st, &base_model, &provider_id, spinner_tick))
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
    thinking: &Option<ThinkingConfig>,
    provider_id: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    // crossterm emits KeyEventKind::Release on some terminals; we only
    // care about presses. Without this check, every key fires twice on
    // Kitty / Wezterm.
    if k.kind != KeyEventKind::Press {
        return false;
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
                st.close_autocomplete();
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

        // PgUp / PgDn — scroll the log by a chunk. 10 lines is the
        // de-facto standard across pagers.
        KeyCode::PageUp => st.scroll_up(10),
        KeyCode::PageDown => st.scroll_down(10),

        // Up / Down — navigate the autocomplete popup when it's open.
        KeyCode::Up => {
            if let Some(ac) = st.autocomplete.as_mut() {
                ac.move_up();
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
        KeyCode::Enter => {
            if shift {
                st.input_push_newline();
                st.refresh_autocomplete();
            } else {
                if let Some(ac) = st.autocomplete.as_ref() {
                    if let Some(name) = ac.commit() {
                        st.input = format!("/{name}");
                    }
                    st.close_autocomplete();
                }
                match slashes::classify(&st.input) {
                    slashes::SlashAction::Clear => {
                        st.clear_conversation();
                    }
                    slashes::SlashAction::Exit => {
                        return true;
                    }
                    slashes::SlashAction::ShowHelp => {
                        st.push_system_note(slashes::help_text());
                    }
                    // `ShowModel`, `SwitchModel`, `ShowStatus`,
                    // `ShowContext`, `ShowSettingsHint` dispatch arms
                    // retired by 015. Post-012a reclass the catalog no
                    // longer routes `/model`, `/status`, `/context`,
                    // `/config`, `/keybindings`, `/statusline` to those
                    // variants — the synthetic system notes had no
                    // upstream analogue per Sector D §B.2. Enum
                    // variants remain in `slashes.rs` for 012c
                    // menu-confirm paths; exhaustive match below uses
                    // a catch-all so dead classify() results are no-ops
                    // rather than panics.
                    slashes::SlashAction::Compact => {
                        st.compact_history();
                    }
                    slashes::SlashAction::Login(provider) => {
                        let provider = if provider.is_empty() { provider_id.to_string() } else { provider };
                        st.push_system_note(format!(
                            "/login needs stdin interaction — exit the TUI and run:\n    otherside login --provider {provider}"
                        ));
                    }
                    slashes::SlashAction::Logout(provider) => {
                        let provider = if provider.is_empty() { provider_id.to_string() } else { provider };
                        st.push_system_note(format!(
                            "to log out: exit the TUI and run:\n    otherside logout --provider {provider}"
                        ));
                    }
                    slashes::SlashAction::MenuPending(kind) => {
                        // 012a fallback — overlay menu widget lands in
                        // 012b. Muted inline note so the slash does not
                        // leak to the provider. Zero network.
                        st.push_system_note(format!(
                            "/{}: menu UI landing in 012b",
                            kind.slash_name()
                        ));
                    }
                    slashes::SlashAction::Rewind => {
                        // 012c wires the real session-history rewind.
                        st.push_system_note(
                            "/rewind: session-history reset lands in 012c".to_string(),
                        );
                    }
                    slashes::SlashAction::ShowKeybindings => {
                        st.push_system_note(
                            "keybindings: Enter submit · Shift+Enter newline · Tab autocomplete · Shift+Tab mode · Esc cancel · Ctrl+C exit".to_string(),
                        );
                    }
                    // Retired dispatch arms (015) — no-op. Post-012a
                    // classify() never returns these for user input;
                    // they survive as enum variants so 012c's menu
                    // confirm paths can construct them directly. The
                    // no-op drops the input silently so an accidental
                    // internal caller doesn't leak a slash to the LLM.
                    slashes::SlashAction::ShowModel
                    | slashes::SlashAction::SwitchModel(_)
                    | slashes::SlashAction::ShowStatus
                    | slashes::SlashAction::ShowContext
                    | slashes::SlashAction::ShowSettingsHint(_) => {
                        st.input.clear();
                        st.autocomplete = None;
                    }
                    slashes::SlashAction::SendToLlm(_)
                    | slashes::SlashAction::Passthrough => {
                        if let Some(history) = st.submit() {
                            let thinking = *thinking;
                            let tx = tx.clone();
                            let model = base_model.to_string();
                            // Lifetime dance: `provider.stream(req, thinking)`
                            // yields a future bound to `&self`. Cloning the
                            // Arc gives the spawned task its own owned handle
                            // so the borrow lives on the task stack, not here.
                            let provider_for_task = provider.clone();
                            let handle = tokio::spawn(async move {
                                run_agent_turns(
                                    provider_for_task,
                                    model,
                                    thinking,
                                    history,
                                    tx,
                                )
                                .await;
                            });
                            // Store the handle so Esc/Ctrl+C can
                            // abort the inflight turn from handle_key.
                            st.turn_task = Some(handle);
                        }
                    }
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

        // Plain character — append to input buffer. We reject chars while
        // streaming so the user doesn't build up a partial prompt they
        // then accidentally submit on the next Enter.
        KeyCode::Char(c) if !ctrl => {
            if !st.streaming {
                st.input_push_char(c);
                st.refresh_autocomplete();
            }
        }

        _ => {}
    }

    false
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
                    if let Some(delta) = turn.fold_chunk(chunk) {
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
                let dispatch_outcome = tools::dispatch(&call.function.name, &args_value);
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
        execute!(out, EnterAlternateScreen)
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
