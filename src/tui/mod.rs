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
pub mod menu;
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
                        st.begin_tool_call(id, name, args);
                    }
                    Some(StreamEvent::ToolCallFinish { id, result, elapsed_ms }) => {
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
    thinking: &mut Option<ThinkingConfig>,
    provider_id: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    // crossterm emits KeyEventKind::Release on some terminals; we only
    // care about presses. Without this check, every key fires twice on
    // Kitty / Wezterm.
    if k.kind != KeyEventKind::Press {
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
    // Esc). Mirrors upstream `local-jsx` mount shape. A menu can
    // request quit via `ExitConfirm` — propagate the bool so the
    // event loop breaks cleanly.
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
                        open_menu_for(st, kind);
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
                    slashes::SlashAction::ToggleVerbose => {
                        let now_on = st.toggle_render_verbose();
                        st.push_system_note(format!(
                            "verbose render: {}",
                            if now_on { "on" } else { "off" }
                        ));
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
                            spawn_agent_turn(
                                st,
                                provider,
                                base_model,
                                thinking,
                                tx,
                                history,
                            );
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

/// Spawn the provider's streaming turn task and pin the resulting
/// Open the overlay matching `kind`. When the variant isn't wired
/// yet, fall back to the legacy "landing in 012b" inline note so the
/// user still sees that the slash fired. Shared by the Enter-dispatch
/// and queue-drain arms.
fn open_menu_for(st: &mut ConversationState, kind: slash_catalog::MenuKind) {
    // Clear input + autocomplete when the overlay takes focus —
    // otherwise the `/effort` text stays in the prompt bar under the
    // overlay and reads as a half-canceled command.
    st.input.clear();
    st.autocomplete = None;
    use slash_catalog::MenuKind as K;
    let overlay = match kind {
        K::Effort => menu::OverlayMenu::new_effort(st.effort_label),
        K::ExitConfirm => menu::OverlayMenu::new_exit_confirm(),
        K::Permissions => menu::OverlayMenu::new_permissions(st.permission_mode),
        K::Model => menu::OverlayMenu::new_model(&st.model),
        K::Help => menu::OverlayMenu::new_info(
            K::Help,
            "Slash commands".into(),
            help_menu_hints(),
        ),
        K::Status => menu::OverlayMenu::new_info(
            K::Status,
            "Session status".into(),
            status_menu_hints(st),
        ),
        K::Context => menu::OverlayMenu::new_info(
            K::Context,
            "Context window".into(),
            context_menu_hints(st),
        ),
        K::Config => menu::OverlayMenu::new_info(
            K::Config,
            "Settings snapshot".into(),
            config_menu_hints(st),
        ),
        K::Skills => menu::OverlayMenu::new_info(
            K::Skills,
            "Skills".into(),
            vec![
                "Skills are bundled under otherside-cli/skills/.".into(),
                "Use the Skill tool to load one mid-turn.".into(),
            ],
        ),
        K::Agents => menu::OverlayMenu::new_info(
            K::Agents,
            "Subagents".into(),
            vec![
                "Subagents live at otherside-cli/agents/.".into(),
                "Invoke via the Agent tool with `subagent_type`.".into(),
            ],
        ),
        K::Mcp => menu::OverlayMenu::new_info(
            K::Mcp,
            "MCP servers".into(),
            vec![
                "MCP JSON-RPC client lands in the Phase 3 tier.".into(),
                "No servers active this session.".into(),
            ],
        ),
        K::Login => menu::OverlayMenu::new_info(
            K::Login,
            "Log in".into(),
            vec![
                "login needs stdin interaction.".into(),
                "Exit and run: otherside login --provider <id>".into(),
            ],
        ),
        K::Logout => menu::OverlayMenu::new_info(
            K::Logout,
            "Log out".into(),
            vec![
                "Exit and run: otherside logout --provider <id>".into(),
            ],
        ),
        K::Plan => menu::OverlayMenu::new_info(
            K::Plan,
            "Plan mode".into(),
            vec![
                "Toggle plan mode with Shift+Tab.".into(),
                "All mutating tools are denied while plan is on.".into(),
            ],
        ),
        K::Hooks => menu::OverlayMenu::new_info(
            K::Hooks,
            "Hooks".into(),
            hooks_menu_hints(st),
        ),
        K::Sandbox => menu::OverlayMenu::new_info(
            K::Sandbox,
            "Sandbox".into(),
            vec![
                "Sandbox isolation is not yet wired.".into(),
                "Tracked in the Phase 3 tier.".into(),
            ],
        ),
        K::Diff => menu::OverlayMenu::new_info(
            K::Diff,
            "Diff".into(),
            vec![
                "Diff picker lands with session history (spec 008).".into(),
            ],
        ),
        K::Resume => menu::OverlayMenu::new_info(
            K::Resume,
            "Resume".into(),
            vec![
                "Session resume lands with persistence (spec 008).".into(),
            ],
        ),
        K::Branch => menu::OverlayMenu::new_info(
            K::Branch,
            "Branch".into(),
            vec![
                "Session branch picker lands with persistence (spec 008).".into(),
            ],
        ),
        K::Copy => menu::OverlayMenu::new_info(
            K::Copy,
            "Copy".into(),
            vec![
                "Copy-to-clipboard lands with persistence (spec 008).".into(),
            ],
        ),
        K::Export => menu::OverlayMenu::new_info(
            K::Export,
            "Export".into(),
            vec![
                "Transcript export lands with persistence (spec 008).".into(),
            ],
        ),
    };
    st.active_menu = Some(overlay);
}

fn help_menu_hints() -> Vec<String> {
    use super::tui::slash_catalog::CATALOG;
    CATALOG
        .iter()
        .map(|e| format!("/{}  —  {}", e.name, e.brief))
        .collect()
}

fn status_menu_hints(st: &ConversationState) -> Vec<String> {
    vec![
        format!("model: {}", st.model),
        format!("permission: {:?}", st.permission_mode),
        format!(
            "context: {}/{}",
            st.input_tokens,
            st.context_window_label()
        ),
        format!(
            "effort: {}",
            st.effort_label.unwrap_or("auto")
        ),
        format!("verbose: {}", if st.render_verbose { "on" } else { "off" }),
    ]
}

fn context_menu_hints(st: &ConversationState) -> Vec<String> {
    let used = st.input_tokens + st.total_output_tokens();
    let pct = if st.context_window == 0 {
        0
    } else {
        (used.saturating_mul(100) / st.context_window).min(100)
    };
    vec![
        format!("window: {}", st.context_window_label()),
        format!("used: ~{} tokens", used),
        format!("fill: {}%", pct),
    ]
}

fn config_menu_hints(st: &ConversationState) -> Vec<String> {
    let mut lines = vec![
        format!(
            "default provider: {}",
            st.settings
                .default_provider
                .clone()
                .unwrap_or_else(|| "(unset)".into())
        ),
        format!(
            "default model: {}",
            st.settings
                .default_model
                .clone()
                .unwrap_or_else(|| "(unset)".into())
        ),
        format!(
            "log level: {}",
            st.settings
                .log_level
                .clone()
                .unwrap_or_else(|| "(unset)".into())
        ),
        format!(
            "effort: {}",
            st.settings
                .effort_level
                .clone()
                .unwrap_or_else(|| "(unset)".into())
        ),
        format!(
            "verbose: {}",
            st.settings
                .verbose
                .map(|b| if b { "true".to_string() } else { "false".to_string() })
                .unwrap_or_else(|| "(unset)".into())
        ),
    ];
    if let Some(sl) = st.settings.statusline.as_ref() {
        lines.push(format!("statusline: {:?}", sl));
    }
    lines
}

fn hooks_menu_hints(st: &ConversationState) -> Vec<String> {
    let Some(h) = st.settings.hooks.as_ref() else {
        return vec!["no hooks configured".into()];
    };
    vec![
        format!("pre_tool_use: {}", h.pre_tool_use.len()),
        format!("post_tool_use: {}", h.post_tool_use.len()),
        format!("user_prompt_submit: {}", h.user_prompt_submit.len()),
        format!("stop: {}", h.stop.len()),
    ]
}

/// Route a key event through the active overlay menu. Consumes
/// Enter / Esc to resolve the overlay and the arrow keys to move the
/// cursor. Everything else is swallowed — menus are modal. Returns
/// `true` when the overlay requested an app-wide exit.
fn handle_menu_key(
    k: KeyEvent,
    st: &mut ConversationState,
    thinking: &mut Option<ThinkingConfig>,
) -> bool {
    // Esc cancels the overlay without a side effect. Explicit
    // `st.active_menu = None` so a future user-configurable close
    // hook has a single mutation point to intercept.
    if matches!(k.code, KeyCode::Esc) {
        st.active_menu = None;
        return false;
    }
    let Some(menu_state) = st.active_menu.as_mut() else {
        return false;
    };
    match k.code {
        KeyCode::Up => menu_state.move_up(),
        KeyCode::Down => menu_state.move_down(),
        KeyCode::Home => menu_state.jump_to_first(),
        KeyCode::End => menu_state.jump_to_last(),
        KeyCode::Enter => {
            let outcome = menu_state.commit_outcome();
            st.active_menu = None;
            if let Some(outcome) = outcome {
                return apply_menu_outcome(st, thinking, outcome);
            }
        }
        _ => {} // modal — swallow everything else
    }
    false
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
/// `SetPermissionMode` swaps the posture, `SetModel` switches model,
/// `ExitApp` propagates a quit request. Returns `true` when the caller
/// should break out of the event loop (only `ExitApp` sets that).
fn apply_menu_outcome(
    st: &mut ConversationState,
    thinking: &mut Option<ThinkingConfig>,
    outcome: menu::OverlayMenuOutcome,
) -> bool {
    match outcome {
        menu::OverlayMenuOutcome::SetEffort { action_id, label } => {
            apply_effort_outcome(st, thinking, &action_id, &label);
            false
        }
        menu::OverlayMenuOutcome::SetPermissionMode { action_id } => {
            apply_permission_outcome(st, &action_id);
            false
        }
        menu::OverlayMenuOutcome::SetModel { model_id } => {
            apply_model_outcome(st, &model_id);
            false
        }
        menu::OverlayMenuOutcome::ExitApp => true,
    }
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
    st.push_system_note(format!("permission mode set to {action_id}"));
}

fn apply_model_outcome(st: &mut ConversationState, model_id: &str) {
    // Re-run the 1M-suffix detector so switching to `claude-opus-4-7[1m]`
    // re-expands the context-window budget.
    let (_base, _thinking) = crate::thinking::parse_suffix(model_id)
        .map(|(m, t)| (m, t))
        .unwrap_or_else(|_| (model_id.to_string(), None));
    st.model = model_id.to_string();
    if model_id.to_lowercase().contains("[1m]") {
        st.context_window = 1_000_000;
    } else {
        st.context_window = 200_000;
    }
    st.push_system_note(format!("model set to {model_id}"));
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
        // Disable the explicit level — next request uses the model's
        // default thinking budget.
        *thinking = Some(ThinkingConfig::auto());
        st.effort_label = None;
        st.settings.effort_level = Some("auto".to_string());
        st.push_system_note("effort level set to auto");
        return;
    }
    match ThinkingLevel::from_str(action_id) {
        Ok(level) => {
            *thinking = Some(ThinkingConfig::level(level));
            st.effort_label = Some(level.as_label());
            st.settings.effort_level = Some(action_id.to_string());
            st.push_system_note(format!("effort level set to {label}"));
        }
        Err(_) => {
            // Shouldn't happen: every overlay action_id is a valid
            // level string. Surface a diagnostic instead of silently
            // swallowing the mismatch.
            st.push_system_note(format!("unknown effort level: {action_id}"));
        }
    }
}

/// `JoinHandle` onto state so Esc / Ctrl+C can abort it. Shared by
/// the Enter dispatch and the queue auto-pop path in the event loop.
fn spawn_agent_turn(
    st: &mut ConversationState,
    provider: &Arc<dyn Provider>,
    base_model: &str,
    thinking: &Option<ThinkingConfig>,
    tx: &mpsc::Sender<StreamEvent>,
    history: Vec<crate::inference::OpenAiChatMessage>,
) {
    let thinking = *thinking;
    let tx = tx.clone();
    let model = base_model.to_string();
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
    if !st.consume_queue_head_into_input() {
        return false;
    }
    // Run the queued text through the same slash classifier the
    // Enter path uses — preserves local-handler semantics for
    // queued slashes (`/clear`, `/help`, etc.). A SendToLlm /
    // Passthrough result routes to the provider via submit().
    match slashes::classify(&st.input) {
        slashes::SlashAction::Clear => {
            st.clear_conversation();
        }
        slashes::SlashAction::Exit => {
            // Queued /exit is honored — drop input but signal
            // the caller so the outer loop can break. Since we're
            // in the rx.recv arm (no direct return), stash the
            // intent via push_system_note and let the next key
            // pick it up. In practice /exit in the queue is edge;
            // users clear the queue via Esc before firing it.
            st.push_system_note("queued /exit — press Ctrl+C twice to quit");
            st.input.clear();
        }
        slashes::SlashAction::ShowHelp => {
            st.push_system_note(slashes::help_text());
        }
        slashes::SlashAction::Compact => {
            st.compact_history();
        }
        slashes::SlashAction::Login(provider_hint) => {
            let provider_hint = if provider_hint.is_empty() {
                provider_id.to_string()
            } else {
                provider_hint
            };
            st.push_system_note(format!(
                "/login needs stdin interaction — exit the TUI and run:\n    otherside login --provider {provider_hint}"
            ));
        }
        slashes::SlashAction::Logout(provider_hint) => {
            let provider_hint = if provider_hint.is_empty() {
                provider_id.to_string()
            } else {
                provider_hint
            };
            st.push_system_note(format!(
                "to log out: exit the TUI and run:\n    otherside logout --provider {provider_hint}"
            ));
        }
        slashes::SlashAction::MenuPending(kind) => {
            open_menu_for(st, kind);
        }
        slashes::SlashAction::Rewind => {
            st.push_system_note(
                "/rewind: session-history reset lands in 012c".to_string(),
            );
        }
        slashes::SlashAction::ShowKeybindings => {
            st.push_system_note(
                "keybindings: Enter submit · Shift+Enter newline · Tab autocomplete · Shift+Tab mode · Esc cancel · Ctrl+C exit".to_string(),
            );
        }
        slashes::SlashAction::ToggleVerbose => {
            let now_on = st.toggle_render_verbose();
            st.push_system_note(format!(
                "verbose render: {}",
                if now_on { "on" } else { "off" }
            ));
        }
        slashes::SlashAction::ShowModel
        | slashes::SlashAction::SwitchModel(_)
        | slashes::SlashAction::ShowStatus
        | slashes::SlashAction::ShowContext
        | slashes::SlashAction::ShowSettingsHint(_) => {
            st.input.clear();
            st.autocomplete = None;
        }
        slashes::SlashAction::SendToLlm(_) | slashes::SlashAction::Passthrough => {
            if let Some(history) = st.submit() {
                spawn_agent_turn(st, provider, base_model, thinking, tx, history);
            }
        }
    }
    true
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

    let input_str = serde_json::to_string(args).unwrap_or_default();
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
