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
use crate::inference::{OpenAiChatRequest, OpenAiChunk};
use crate::provider::{Provider, Registry};
use crate::thinking::{parse_suffix, ThinkingConfig};

pub mod render;
pub mod state;

use state::ConversationState;

/// Event payloads coming from the inference task, pushed onto the mpsc
/// channel. Key events are consumed directly from `EventStream` in the
/// main loop — they don't ride this enum.
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
) -> Result<()> {
    let mut st = ConversationState::new();
    let mut key_stream = EventStream::new();

    // Spinner animates at ~10fps so streaming feels alive even when the
    // provider is between chunks. The same interval doubles as a forced
    // redraw so any state change without a keypress / chunk still paints.
    let mut ticker = tokio::time::interval(Duration::from_millis(100));
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
                        if handle_key(k, &mut st, &provider, &base_model, &thinking, &tx) {
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

    match k.code {
        // Ctrl+C / Esc — always exit, regardless of streaming state.
        KeyCode::Char('c') if ctrl => return true,
        KeyCode::Esc => return true,

        // Ctrl+D — only quit when the input is empty (classic shell
        // semantics). A non-empty input means "don't quit, user is typing".
        KeyCode::Char('d') if ctrl && st.input.is_empty() => return true,

        // Ctrl+L — force a redraw by doing nothing; the outer loop
        // redraws after every event. (Cheap clear-screen equivalent.)
        KeyCode::Char('l') if ctrl => {}

        // PgUp / PgDn — scroll the log by a chunk. 10 lines is the
        // de-facto standard across pagers.
        KeyCode::PageUp => st.scroll_up(10),
        KeyCode::PageDown => st.scroll_down(10),

        // Enter — submit or newline, depending on Shift.
        KeyCode::Enter => {
            if shift {
                st.input_push_newline();
            } else if let Some(history) = st.submit() {
                // Build the canonical request; cloning small bits so the
                // spawn boundary owns only 'static data.
                let req = OpenAiChatRequest {
                    model: base_model.to_string(),
                    messages: history,
                    stream: Some(true),
                    max_tokens: None,
                    temperature: None,
                    top_p: None,
                    stop: None,
                    tools: Vec::new(),
                    tool_choice: None,
                    extra: serde_json::Map::new(),
                };
                let thinking = *thinking;
                let tx = tx.clone();

                // Lifetime dance: `provider.stream(req, thinking)` yields
                // a future bound to `&self`. We can't move that future
                // into a spawned task. But `Arc<dyn Provider>` is
                // cheaply clonable and gives every task its own owned
                // handle, so the `&self` inside the spawned task borrows
                // from the task-owned Arc, not from the main-task stack.
                let provider_for_task = provider.clone();
                tokio::spawn(async move {
                    let fut = provider_for_task.stream(req, thinking);
                    pump_stream(fut, tx).await;
                });
            }
        }

        // Backspace — char-at-a-time delete. Shells also bind Ctrl+H to
        // backspace historically; some terminals send it for backspace,
        // others for literal ^H. We honor both.
        KeyCode::Backspace => st.input_backspace(),
        KeyCode::Char('h') if ctrl => st.input_backspace(),

        // Plain character — append to input buffer. We reject chars while
        // streaming so the user doesn't build up a partial prompt they
        // then accidentally submit on the next Enter.
        KeyCode::Char(c) if !ctrl => {
            if !st.streaming {
                st.input_push_char(c);
            }
        }

        _ => {}
    }

    false
}

/// Drive a single provider stream to completion, pushing events onto the
/// channel. Runs in its own tokio task so the main UI loop never blocks
/// on I/O.
///
/// Why accept a future rather than a stream directly? `provider.stream`
/// returns `Future<Output = Result<Stream<...>>>` — the future resolves
/// only after the HTTP connection is open. Awaiting it here (inside the
/// task) means connection setup failures land as `StreamEvent::Error`
/// just like mid-stream errors, uniform error path for the UI.
async fn pump_stream<F>(stream_fut: F, tx: mpsc::Sender<StreamEvent>)
where
    F: std::future::Future<Output = Result<crate::provider::ChunkStream>>,
{
    let mut stream = match stream_fut.await {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.send(StreamEvent::Error(format_err(&e))).await;
            return;
        }
    };

    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if let Some(delta) = extract_delta_content(chunk) {
                    if !delta.is_empty()
                        && tx.send(StreamEvent::Delta(delta)).await.is_err()
                    {
                        return;
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(StreamEvent::Error(format_err(&e))).await;
                return;
            }
        }
    }
    let _ = tx.send(StreamEvent::Done).await;
}

/// Extract the first non-empty content delta from a chunk, if present.
/// The canonical OpenAI shape allows multiple `choices` but we only ever
/// see one from the translator; anything else would be a translator bug
/// rather than a TUI concern.
fn extract_delta_content(chunk: OpenAiChunk) -> Option<String> {
    chunk
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.delta.content)
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
