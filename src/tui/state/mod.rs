//! Pure conversation + input state for the TUI.
//!
//! This module is deliberately free of ratatui / crossterm / tokio. Every
//! state transition is a plain method on [`ConversationState`] so the unit
//! tests at the bottom of this file can exercise the behavior without
//! spinning up a terminal or an async runtime.
//!
//! # What the state owns
//!
//! - The linear message log (`messages`) — role + content, in order.
//! - The current input-line buffer (`input`) — the raw UTF-8 the user is
//!   typing; the render layer decides how to wrap it.
//! - The scroll offset into the message log (`scroll_offset`) — zero means
//!   "pinned to the newest message" so that streaming output auto-follows.
//! - Streaming flags (`streaming`, `current_assistant_buffer`) — while a
//!   request is in flight we accumulate deltas into the buffer; the render
//!   layer shows it as a live "assistant:" bubble.
//! - The last error string (`last_error`), if any — rendered inline in the
//!   error color. Cleared the next time the user submits successfully.
//!
//! # What the state does NOT own
//!
//! - The provider / registry / model id. Those live in the outer event
//!   loop; the state is concerned only with the shape of the conversation.
//! - The actual network call. The event loop spawns a task that pushes
//!   [`crate::inference::OpenAiChunk`] events onto a channel; when a chunk
//!   arrives the loop calls [`ConversationState::append_stream_delta`].
//!
//! # Multi-turn semantics
//!
//! On submit we:
//!   1. Snapshot the current input into a [`DisplayMessage`] with role `User`
//!      and append it to `messages`.
//!   2. Clear `input`, flip `streaming = true`, clear
//!      `current_assistant_buffer`.
//!   3. Return the full message history (user messages + assistant messages
//!      finalized so far) so the event loop can build the
//!      [`OpenAiChatRequest`] that gets handed to the provider.
//!
//! When the stream finishes we:
//!   - Fold `current_assistant_buffer` into a new assistant
//!     [`DisplayMessage`] and push it onto `messages`.
//!   - Clear `current_assistant_buffer`, flip `streaming = false`.
//!
//! On stream error we:
//!   - Keep any partial assistant text (so the user sees what arrived).
//!   - Store the error string in `last_error`.
//!   - Flip `streaming = false` so the input is editable again.
//!
//! # Tool-call surface (015)
//!
//! [`ConversationState::active_tool_calls`] holds the in-flight and
//! finalized tool-call entries for the current turn. The agent loop
//! emits typed `StreamEvent::ToolCallStart` / `ToolCallFinish` events
//! which route into [`ConversationState::begin_tool_call`] /
//! [`ConversationState::finish_tool_call`]. Begin-Finish pairs by `id`
//! and transition the entry through
//! [`tool_render::ToolStatus`] `Running` → `Ok` / `Error`.
//! [`ConversationState::submit`] clears the vector so each turn starts
//! fresh; an orphan Finish (no matching Start) emits a `tracing::warn!`
//! and is dropped without mutating state.
//!
//! # Message queue (017 §4)
//!
//! Upstream lets the user type while a stream is in flight —
//! Enter pushes to a queue instead of submitting. When the
//! current turn finishes (cleanly or with an error), the queue head
//! is auto-popped as the next turn's input and re-submitted. The
//! queue surfaces in the prompt bar as a muted chip `⏸ N queued ·
//! press up to edit`, and Up at empty input restores the most-recent
//! queued entry for editing (tail, not head — see
//! `openspec/changes/017-cancel-keys-and-queue/design.md` "Decision:
//! Up-arrow restores the queue TAIL"). Methods:
//! [`ConversationState::push_to_queue`] (tail push from Enter-while-
//! streaming), [`ConversationState::pop_queue_head`] (FIFO drain on
//! finish), [`ConversationState::pop_queue_tail`] (LIFO restore on
//! Up), [`ConversationState::has_queued_messages`]. The event loop
//! owns the auto-submit — `finish_stream` / `fail_stream` leave the
//! queue intact; the loop's `Done` / `Error` / channel-closed arms
//! invoke [`ConversationState::consume_queue_head_into_input`] and
//! call [`ConversationState::submit`] to fire the next turn. Mirror
//! on fail matches the symmetry in upstream's turn-finish path
//! (design.md §4.10 open question resolved here per user scope brief).

use std::time::Instant;

use serde_json::Value;

use crate::inference::{OpenAiChatMessage, OpenAiChatRole};

use super::autocomplete::Autocomplete;
use super::tool_render::{self, ToolStatus};
#[cfg(test)]
use super::tool_render::ToolPayload;

/// Provider-visibility discriminator for a `DisplayMessage`.
///
/// Upstream claude-code marks each visible transcript row as
/// `display: "system"` (chrome — visible locally, stripped from the
/// outgoing `/v1/messages` body) or conversation content (serialized
/// to the provider on the next turn). Otherside needs the same split
/// so panel dismissals, toggle confirmations, and auth hints stay
/// local while real user/assistant turns and genuine Anchor slashes
/// (`/compact`, `/branch`, `/loop`, `/context`) ride the wire.
///
/// No `Default` impl on purpose (R-92) — every new construction site
/// must classify explicitly, so silent leaks fail at compile time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayOrigin {
    /// Reaches the provider on the next `/v1/messages` turn.
    Transcript,
    /// Local chrome only — filtered at `history_for_request`.
    Chrome,
}

/// A finalized message in the chat log.
///
/// `role` is one of `User` / `Assistant` / `System` — we reuse the canonical
/// OpenAI role enum so building an [`OpenAiChatMessage`] for the next
/// request is a field-for-field copy, no translation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayMessage {
    pub role: OpenAiChatRole,
    pub content: String,
    /// When set, this is the payload sent over the wire to the
    /// provider — `content` stays as the visible transcript echo.
    /// Used by Skill-category slashes so the SKILL.md body rides
    /// the request without leaking into the user-facing log (only
    /// `❯ /<name>` appears on screen).
    pub wire_override: Option<String>,
    /// Chrome rows are filtered at the wire boundary (see
    /// `DisplayOrigin`). Mirrors upstream's `display: "system"` flag
    /// on panel / hint emissions (R-92 evidence: `reconstructed/
    /// 2.1.114/source/components/Settings/Settings.tsx:46`).
    pub origin: DisplayOrigin,
    /// Assistant rows: the `tool_use` blocks the model emitted in
    /// this turn. Empty for non-assistant rows. Preserved across
    /// turns so the next-turn `messages[]` carries the assistant
    /// `tool_use` blocks the model needs to reconcile against any
    /// `<task-notification>` injected later (upstream parity:
    /// every BG dispatch must round-trip the original tool_use_id
    /// in history; see `tasks/LocalAgentTask/
    /// LocalAgentTask.tsx:247-257`). Currently populated only by
    /// the Role::Tool synthesis path in `history_for_request`;
    /// the `finish_stream` archival continues to coalesce
    /// tool calls into Role::Tool DisplayMessages.
    #[allow(dead_code)] // populated synthesis-side; reserved for future archival path
    pub tool_calls: Vec<crate::inference::OpenAiToolCall>,
    /// Tool rows: id of the originating `tool_use` this row
    /// resolves. None for non-tool rows. Populated synthesis-side
    /// in `history_for_request` from the archive's `id` field.
    #[allow(dead_code)] // populated synthesis-side
    pub tool_call_id: Option<String>,
    /// `true` when the row was injected by the system (not typed
    /// by the user, not produced by the model). Today populated
    /// only by [`Self::consume_pending_notifications`] for the
    /// `<task-notification>` user messages auto-fired between
    /// turns. The render layer skips synthetic rows so the user
    /// doesn't see XML in the chat log; `history_for_request`
    /// includes them so the model receives the notification on
    /// the wire. Mirrors upstream's queue items rendered with
    /// `display: 'system'` semantics.
    pub is_synthetic: bool,
}

mod tool_call_entry;
pub use tool_call_entry::{format_tool_history_entry, ToolCallEntry};

/// Color-token discriminant for the info-row permission chip. Names
/// describe the chip's role, not a specific hue — the render layer
/// resolves each variant through `tui::render::theme` so no inline
/// RGB literals live in the permission-chip render path (C46).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipColor {
    /// Sage — plan mode (read-only exploration).
    PlanMode,
    /// Distinct teal-cyan — accept-edits mode. Deliberately chosen to
    /// avoid the three-way blue-violet collision between upstream's
    /// `autoAccept` violet, otherside PRIMARY, and brand deep violet
    /// (016 §TODO-3 resolution, C69).
    AutoAccept,
    /// Dark red — high-risk modes (yolo / bypass).
    Error,
}

/// Info-row permission-mode chip spec. `symbol` is the leading glyph
/// (`⏸` for plan, `⏵⏵` for the chevron-variants). `text` is the
/// lowercase body ending in ` on`. `color` is the theme token the
/// render layer resolves. The `(shift+tab to cycle)` suffix is NOT
/// included here — it's a render-site concern gated on how many
/// other chips crowd the info row (upstream `primaryItemCount < 2`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionChip {
    pub symbol: &'static str,
    pub text: String,
    pub color: ChipColor,
}

/// Everything the TUI needs to render + drive the next request.
#[derive(Debug, Default)]
pub struct ConversationState {
    /// Finalized messages, in insertion order. Does NOT include the
    /// in-flight assistant response — that lives in
    /// `current_assistant_buffer` until the stream finishes.
    pub messages: Vec<DisplayMessage>,

    /// Raw UTF-8 input buffer. Newlines (`\n`) are literal — rendered as
    /// wrapped lines. No prompt marker is stored here; the render layer
    /// draws the `>` prefix.
    pub input: String,

    /// One-shot wire-content override consumed by the next `submit`.
    /// Set by Skill-category slashes so the visible echo stays
    /// `/<name>` while the full SKILL body rides the wire. Cleared
    /// in `submit()` via `take()`.
    pub pending_wire_override: Option<String>,

    /// Re-paint the splash mascot above the transcript until the
    /// next user submit lands. Set by `clear_conversation` so the
    /// `/clear` state visually matches upstream — mascot + cwd
    /// banner above the `⎿ (no content)` anchor. Cleared the moment
    /// a new user turn fires.
    pub show_post_clear_splash: bool,

    /// Scroll offset from the bottom of the log, measured in lines. `0`
    /// means pinned to the newest message; a positive value scrolls up.
    /// The render layer clamps to the log's line count when drawing.
    pub scroll_offset: usize,

    /// `true` between submit and stream-done/stream-error. While true, we
    /// reject further Enter submits and show a "streaming" indicator.
    pub streaming: bool,

    /// Accumulator for the currently-streaming assistant response. Render
    /// treats this as a virtual trailing message while `streaming` is true.
    pub current_assistant_buffer: String,

    /// Last error surfaced by the provider. Rendered below the log in the
    /// error color. Cleared on the next successful submit.
    pub last_error: Option<String>,

    /// When the current in-flight request was dispatched. Drives the
    /// progress line's elapsed counter (C46). `None` when idle.
    pub request_started_at: Option<Instant>,

    /// Output tokens for the CURRENT in-flight assistant message
    /// only — Anthropic's `message_delta` carries the final output
    /// count for a message (one event at message end, not running
    /// deltas). Reset to 0 on a new-message boundary (detected via
    /// the next `message_start`'s `input_tokens` landing in
    /// [`ConversationState::update_usage`]); the prior message's
    /// final count folds into [`ConversationState::cumulative_output_tokens`]
    /// before the reset.
    pub output_tokens: u64,

    /// Output tokens finalized on prior messages in the current
    /// agent-loop turn (tool-call sub-turns accumulate here). Used
    /// for the in-turn progress line via
    /// [`ConversationState::total_output_tokens`]. Deliberately NOT
    /// included in the bottom-right info-row chip formula — that
    /// mirrors upstream `tokenCountFromLastAPIResponse` which reads
    /// only the last message's `input + cache + output`; the prior
    /// sub-turns' output already rides in the next sub-turn's
    /// `input_tokens` via history, so summing cumulative on top
    /// would double-count.
    pub cumulative_output_tokens: u64,

    /// Input tokens consumed so far this session. Maps to the
    /// context-window arithmetic on the statusline.
    pub input_tokens: u64,

    /// Session identity (model, effort_label, permission_mode,
    /// context_window). Single source of truth — see
    /// `crate::state::Session` rustdoc. Render paths, overlay
    /// constructors, and the statusline look up via `st.session.*`;
    /// they never copy these fields into locals.
    pub session: crate::state::Session,

    /// Cumulative thinking-block duration for the in-flight response,
    /// in ms. Reset on each submit.
    pub thought_ms: u64,

    /// Tip index for the rotating tip line. Bumped on every submit so
    /// long sessions see a wider set of tips.
    pub tip_rotation_index: usize,

    /// Active slash-autocomplete popup, if any.
    pub autocomplete: Option<Autocomplete>,

    /// Tail-follow flag. `true` means the log auto-pins to the newest
    /// delta; `false` means the user scrolled up and expects subsequent
    /// deltas to flow off-screen without yanking the view. Mirrors
    /// upstream `ScrollBox.stickyScroll` semantics — the user's scroll
    /// intent survives across stream events and across turn boundaries
    /// until they explicitly scroll back to zero or submit a new turn.
    pub sticky_bottom: bool,

    /// Verb displayed in the progress spinner for the current turn.
    /// Seeded once on submit and cleared on finish/fail — upstream
    /// picks a `useState(() => sample(verbs))` at mount and holds it
    /// for the turn; otherside mirrors that shape so the word stays
    /// stable under tick-indexed spinner-frame rotation.
    pub turn_verb: Option<&'static str>,

    /// JoinHandle of the currently-running turn task. `Some` while
    /// streaming; abort()ed by Esc / Ctrl+C to cancel the in-flight
    /// turn. Cleared when the stream completes.
    #[allow(clippy::type_complexity)]
    pub turn_task: Option<tokio::task::JoinHandle<()>>,

    /// Timestamp of the first Ctrl+C / Ctrl+D press when no turn is
    /// running — arms the double-press-to-exit window. Cleared by
    /// any other key or by the window elapsing. See upstream
    /// `useExitOnCtrlCD` + `useDoublePress` (800ms).
    pub exit_armed_at: Option<Instant>,

    /// Which key armed the exit confirmation. Presented in the info-row
    /// hint so the user sees the matching label (`Ctrl+C` or `Ctrl+D`).
    pub exit_armed_key: Option<&'static str>,

    /// In-flight + finalized tool calls for the current turn. Cleared
    /// on [`submit`](Self::submit) so a new user turn starts fresh.
    /// The render path interleaves these between finalized messages
    /// and the in-flight assistant buffer via
    /// [`tool_render::render_tool_call`]. Order = insertion order =
    /// upstream's transcript ordering.
    pub active_tool_calls: Vec<ToolCallEntry>,

    /// Messages the user typed + hit Enter on while a prior turn was
    /// streaming (017 §4). Enter-while-streaming pushes the input to
    /// the tail here instead of submitting; [`finish_stream`] /
    /// [`fail_stream`] leave the queue untouched so the event loop
    /// can pop the head and synthesize the next turn. Up-arrow at
    /// empty input pops the TAIL (most-recent) for editing; idle
    /// cancel (future §2) pops the HEAD. Vec (not VecDeque) because
    /// N is human-typed and stays small — see design.md "Decision:
    /// Queue lives on ConversationState as Vec<String>".
    pub queued_messages: Vec<String>,

    /// Resolved user-scope settings loaded at TUI bootstrap. The
    /// permission gate (`tools::dispatch_gated`) reads the allow /
    /// deny / ask rule lists from here; Default gives an empty
    /// PermissionsConfig so tests and legacy construction paths stay
    /// green without explicit wiring.
    pub settings: crate::config::settings::Settings,

    /// Render-verbosity flag — toggled via `/verbose`. When `true`,
    /// tool-use headers and result previews expand to match
    /// upstream's verbose branches (full bash output, Glob / Grep
    /// file listings inline, Read `lines a-b` qualifier, WebFetch
    /// result body appended). Independent from the logging-level
    /// `--verbose` CLI flag — that one controls tracing, this one
    /// controls what lands on the transcript. See
    /// `tools/*Tool/UI.tsx` `verbose: boolean` param.
    pub render_verbose: bool,

    /// Currently-active overlay menu, if any. `Some` ≡ modal focus
    /// capture — the event loop routes keys to the menu handler and
    /// the render path paints the overlay over the prompt bar. Clears
    /// on commit or cancel. Mirrors upstream's `local-jsx` mount shape.
    pub active_menu: Option<super::menu::OverlayMenu>,

    /// Pending permission prompt — set when the agent task surfaces a
    /// `Decision::Ask` and the user has not yet chosen. Owns the
    /// one-shot reply channel so the agent unblocks on commit / Esc.
    /// Takes precedence over `active_menu` for focus capture.
    pub pending_permission: Option<super::menu::PendingPermissionPrompt>,

    /// Pending agent-driven question (`AskUserQuestion` tool). Same
    /// focus-capture discipline as the permission prompt; the reply
    /// is free-form text.
    pub pending_question: Option<super::menu::PendingQuestion>,

    /// Session-scoped allowlist shared with the agent task. When the
    /// user picks "Allow and don't ask again" we push the rule here;
    /// every subsequent dispatch consults the snapshot in-line.
    pub session_allowlist: crate::permissions::RuntimePermissionGrants,

    /// JSONL transcript writer — set at TUI bootstrap when sessions
    /// persistence is enabled (spec 008). `None` for tests or when
    /// the config dir isn't available. Every user / assistant /
    /// tool event fsyncs one record.
    pub session_writer: Option<crate::sessions::transcript::Writer>,

    /// Session id — `None` when `session_writer` is `None`.
    pub session_id: Option<crate::sessions::SessionId>,

    /// Background task store — populated by Ctrl+B (foreground →
    /// background) and by tools that spawn agents in background.
    /// Read by the footer pill render and the `/tasks` dialog.
    /// `Arc<RwLock<...>>` internally so cheap to clone for the
    /// runner-side `tokio::spawn_blocking` closures (see
    /// `crate::tasks::spawn_background_agent`).
    pub tasks: crate::tasks::TaskStore,

    /// Ephemeral toggle feedback shown in the bottom-left info slot
    /// (openspec 001 phase 4). Present only for FEEDBACK_TTL after a
    /// toggle-category slash fires; the prune_feedback helper clears
    /// it at frame start once the TTL elapses. Mirrors upstream's
    /// "plan mode on" / "copied 42 turns" confirmation line.
    pub toggle_feedback: Option<(String, Instant)>,
}

impl ConversationState {
    /// Append a transcript record to the session writer, if one is
    /// configured. Never errors — persistence failures are logged
    /// via tracing and swallowed so the TUI stays interactive.
    pub fn append_record(&mut self, record: crate::sessions::Record) {
        if let Some(w) = self.session_writer.as_mut() {
            if let Err(e) = w.append(&record) {
                tracing::warn!(?e, "failed to append session record");
            }
        }
    }

    /// Stamp an ephemeral toggle confirmation into the info-row left
    /// slot. Replaces any prior feedback. The TTL timer restarts.
    pub fn set_feedback(&mut self, msg: impl Into<String>) {
        self.toggle_feedback = Some((msg.into(), Instant::now()));
    }

    /// Drop expired feedback so the info row returns to chip-only.
    /// Called at frame start by the render path.
    pub fn prune_feedback(&mut self) {
        if let Some((_, stamped)) = &self.toggle_feedback {
            if stamped.elapsed() >= FEEDBACK_TTL {
                self.toggle_feedback = None;
            }
        }
    }
}

/// Which [`crate::tasks::TaskKind`] a given tool-call name maps to for
/// the background-task surface. `None` for tools that don't produce
/// user-backgroundable work (Read / Edit / Glob / Grep / Write /
/// NotebookEdit — fast atomic tool calls upstream also doesn't
/// background). Agent + Bash are the two backgroundable kinds
/// upstream exposes (`tasks/LocalAgentTask.tsx` + `LocalShellTask.tsx`).
fn backgroundable_kind(tool_name: &str) -> Option<crate::tasks::TaskKind> {
    match tool_name {
        "Agent" => Some(crate::tasks::TaskKind::Agent),
        "Bash" => Some(crate::tasks::TaskKind::Shell),
        _ => None,
    }
}

/// Short human label shown in the footer pill hover / detail view.
/// For Agent: the `subagent_type` arg. For Bash: the first ~40 chars
/// of the command. Falls back to the tool name on parse failure.
fn summarize_tool_invocation(name: &str, args: &Value) -> String {
    match name {
        "Agent" => args
            .get("subagent_type")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "agent".into()),
        "Bash" => args
            .get("command")
            .and_then(Value::as_str)
            .map(|s| s.chars().take(40).collect::<String>())
            .unwrap_or_else(|| "bash".into()),
        other => other.to_string(),
    }
}

/// How long an ephemeral toggle confirmation stays pinned in the info
/// row before the prune pass clears it. Matches upstream's observed
/// feedback duration from the tmux-parity captures (~3s).
pub const FEEDBACK_TTL: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(test)]
mod feedback_tests {
    use super::*;

    #[test]
    fn feedback_is_none_by_default() {
        let st = ConversationState::default();
        assert!(st.toggle_feedback.is_none());
    }

    #[test]
    fn set_feedback_stamps_now() {
        let mut st = ConversationState::default();
        st.set_feedback("plan mode on");
        let (msg, _) = st.toggle_feedback.as_ref().unwrap();
        assert_eq!(msg, "plan mode on");
    }

    #[test]
    fn prune_feedback_keeps_fresh_entries() {
        let mut st = ConversationState::default();
        st.set_feedback("fresh");
        st.prune_feedback();
        assert!(st.toggle_feedback.is_some());
    }

    #[test]
    fn prune_feedback_drops_expired_entries() {
        let mut st = ConversationState::default();
        // Stamp a feedback in the past beyond TTL.
        st.toggle_feedback = Some((
            "stale".to_string(),
            Instant::now() - FEEDBACK_TTL - std::time::Duration::from_millis(100),
        ));
        st.prune_feedback();
        assert!(st.toggle_feedback.is_none());
    }

    #[test]
    fn push_anchor_emits_echo_plus_result_line() {
        let mut st = ConversationState::default();
        st.push_anchor("compact", "", "42 msgs dropped", DisplayOrigin::Transcript);
        assert_eq!(st.messages.len(), 2);
        assert_eq!(st.messages[0].role, super::OpenAiChatRole::User);
        assert_eq!(st.messages[0].content, "/compact");
        assert_eq!(st.messages[0].origin, DisplayOrigin::Transcript);
        assert_eq!(st.messages[1].role, super::OpenAiChatRole::System);
        assert!(st.messages[1].content.starts_with("⎿ "));
        assert!(st.messages[1].content.contains("42 msgs dropped"));
        assert_eq!(st.messages[1].origin, DisplayOrigin::Transcript);
    }

    #[test]
    fn push_anchor_with_args_echoes_them() {
        let mut st = ConversationState::default();
        st.push_anchor("compact", "trim-to 3", "ok", DisplayOrigin::Transcript);
        assert_eq!(st.messages[0].content, "/compact trim-to 3");
    }

    #[test]
    fn history_for_request_skips_chrome_anchors() {
        // Panel dismissal anchor (Chrome) must NOT reach the wire;
        // only the real user turn survives in the request body. R-92
        // evidence: upstream `Settings.tsx:46` marks dismiss with
        // `display: "system"` so the history serializer strips it.
        let mut st = ConversationState::default();
        // Panel dismissal — two Chrome rows.
        st.push_anchor("config", "", "Status dialog dismissed", DisplayOrigin::Chrome);
        // Real user turn — one Transcript row.
        st.input = "what does main.rs do?".into();
        let _ = st.submit();
        // messages contains 3 rows total (chrome pair + user turn).
        assert_eq!(st.messages.len(), 3);
        // history_for_request emits only the real user turn.
        let hist = st.history_for_request();
        assert_eq!(hist.len(), 1, "chrome anchors must not ride the wire");
        assert_eq!(hist[0].content, "what does main.rs do?");
    }

    #[test]
    fn history_for_request_includes_transcript_anchors() {
        // Anchor-category slashes (`/compact`, `/branch`, `/loop`,
        // `/context`) carry semantic meaning — they MUST reach the
        // provider. Guard against a future default-flip regression.
        let mut st = ConversationState::default();
        st.push_anchor("compact", "", "42 msgs dropped", DisplayOrigin::Transcript);
        let hist = st.history_for_request();
        assert_eq!(hist.len(), 2, "anchor pair rides the wire");
        assert_eq!(hist[0].content, "/compact");
        assert!(hist[1].content.starts_with("⎿ "));
    }

    #[test]
    fn push_system_note_is_chrome() {
        // Auth hints, wakeup alarms, error notes — all local chrome.
        let mut st = ConversationState::default();
        st.push_system_note("login needs stdin interaction");
        assert_eq!(st.messages.len(), 1);
        assert_eq!(st.messages[0].origin, DisplayOrigin::Chrome);
        assert!(st.history_for_request().is_empty(), "system notes stay local");
    }

    #[test]
    fn pending_wire_override_rides_history_but_not_display() {
        // Skill dispatch path: visible echo is `/dream`, wire carries
        // the full SKILL.md body. history_for_request must surface the
        // body; st.messages must surface the echo.
        let mut st = ConversationState::default();
        st.input = "/dream".into();
        st.pending_wire_override = Some(
            "---\nname: dream\n---\nfull skill body here".into(),
        );
        let _ = st.submit();
        assert_eq!(st.messages.len(), 1);
        assert_eq!(st.messages[0].content, "/dream", "visible echo kept");
        assert_eq!(
            st.messages[0].wire_override.as_deref(),
            Some("---\nname: dream\n---\nfull skill body here"),
        );
        assert!(st.pending_wire_override.is_none(), "consumed on submit");
        let hist = st.history_for_request();
        assert_eq!(hist.len(), 1);
        assert!(
            hist[0].content.contains("full skill body here"),
            "wire carries body, got: {:?}",
            hist[0].content
        );
    }

    #[test]
    fn clear_conversation_sets_post_clear_splash_flag() {
        let mut st = ConversationState::default();
        st.messages.push(DisplayMessage {
            role: super::OpenAiChatRole::Assistant,
            content: "prior turn".into(),
            wire_override: None,
            origin: DisplayOrigin::Transcript,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        assert!(!st.show_post_clear_splash);
        st.clear_conversation();
        assert!(st.show_post_clear_splash, "flag must be set after /clear");
        st.input = "next turn".into();
        let _ = st.submit();
        assert!(!st.show_post_clear_splash, "flag must clear on next submit");
    }

    #[test]
    fn clear_conversation_zeros_token_counters() {
        let mut st = ConversationState::default();
        st.input_tokens = 21_000;
        st.output_tokens = 120;
        st.cumulative_output_tokens = 500;
        st.thought_ms = 999;
        st.messages.push(DisplayMessage {
            role: super::OpenAiChatRole::User,
            content: "hi".into(),
            wire_override: None,
            origin: DisplayOrigin::Transcript,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        st.clear_conversation();
        assert_eq!(st.input_tokens, 0);
        assert_eq!(st.output_tokens, 0);
        assert_eq!(st.cumulative_output_tokens, 0);
        assert_eq!(st.thought_ms, 0);
        assert!(st.messages.is_empty());
    }
}

/// Double-press-to-exit window — must match upstream's
/// `DOUBLE_PRESS_TIMEOUT_MS` exactly (800ms).
pub const EXIT_DOUBLE_PRESS_MS: u64 = 800;

impl ConversationState {
    /// Fresh state with no messages, empty input, scroll pinned to bottom.
    pub fn new() -> Self {
        Self {
            session: crate::state::Session::new(
                "",
                crate::config::PermissionMode::Default,
            ),
            sticky_bottom: true,
            ..Self::default()
        }
    }

    /// Fresh state sized to the model's context window — 1M when the
    /// raw model alias carries a `[1m]` suffix, 200K otherwise. Mirrors
    /// upstream `getContextWindowForModel`. The `permission_mode`
    /// argument seeds the session mode so `--yolo` (or a policy-set
    /// mode) is respected on launch.
    pub fn new_for_model(raw_model: &str) -> Self {
        Self::new_for_model_with_mode(raw_model, crate::config::PermissionMode::Default)
    }

    pub fn new_for_model_with_mode(
        raw_model: &str,
        mode: crate::config::PermissionMode,
    ) -> Self {
        Self {
            session: crate::state::Session::new(raw_model, mode),
            sticky_bottom: true,
            ..Self::default()
        }
    }

    /// Percentage of the context window currently consumed. Delegates
    /// to [`Session::context_used_percent`] — Session owns the
    /// budget, Conversation owns the consumption counter.
    pub fn context_used_percent(&self) -> u32 {
        self.session.context_used_percent(self.input_tokens)
    }

    /// Tokens remaining in the context window.
    pub fn context_available(&self) -> u64 {
        self.session.context_available(self.input_tokens)
    }

    /// Render the context-window total — delegates to
    /// [`Session::context_window_label`].
    pub fn context_window_label(&self) -> String {
        self.session.context_window_label()
    }

    /// Append a single character typed by the user to the input buffer.
    pub fn input_push_char(&mut self, c: char) {
        self.input.push(c);
    }

    /// Insert a literal newline (`\n`) at the end of the input buffer —
    /// bound to `Shift+Enter`. Kept as a dedicated method (instead of just
    /// `input_push_char('\n')`) so the meaning is obvious at the call site.
    pub fn input_push_newline(&mut self) {
        self.input.push('\n');
    }

    /// Backspace — remove the last char (UTF-8 safe).
    pub fn input_backspace(&mut self) {
        self.input.pop();
    }

    /// Wipe the input buffer. Used after submit, and as a safety hatch on
    /// `Ctrl+U`-style clears if we wire one in later.
    pub fn input_clear(&mut self) {
        self.input.clear();
    }

    /// Scroll up one line, saturating so we never overflow. Exact cap
    /// against the rendered line count happens in the render layer because
    /// it knows the wrapped height; here we just increment.
    pub fn scroll_up(&mut self, lines: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(lines);
        self.sticky_bottom = false;
    }

    /// Scroll down toward the newest message. Saturates at zero which
    /// re-engages tail-follow.
    pub fn scroll_down(&mut self, lines: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(lines);
        if self.scroll_offset == 0 {
            self.sticky_bottom = true;
        }
    }

    /// Pin the log to the newest message and re-engage tail-follow.
    /// Called on submit so a new turn always starts at the bottom.
    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
        self.sticky_bottom = true;
    }

    /// Attempt to submit the current input as a new user turn.
    ///
    /// Returns `Some(history)` — the full message list that should be sent
    /// to the provider — when the submission was accepted. Returns `None`
    /// when the input was empty, OR when a stream is already in flight
    /// (in which case the trimmed input is redirected onto
    /// [`queued_messages`] for auto-pop on turn finish per 017 §4). The
    /// caller should ignore the keypress either way — the queue path is
    /// a silent side-channel.
    ///
    /// Side effects on success:
    ///   - Pushes the user's [`DisplayMessage`] onto `messages`.
    ///   - Clears `input`, flips `streaming = true`, clears the assistant
    ///     buffer, drops any previous error, scrolls to bottom.
    ///
    /// Side effects when streaming (queue redirect, 017 §4):
    ///   - Trimmed input appended to `queued_messages`.
    ///   - `input` cleared, `autocomplete` dropped.
    ///   - `streaming` stays true; no provider dispatch.
    ///   - Empty / whitespace-only input is dropped silently (no queue
    ///     entry, matches idle submit's empty-input short-circuit).
    pub fn submit(&mut self) -> Option<Vec<OpenAiChatMessage>> {
        if self.streaming {
            let trimmed = self.input.trim();
            if !trimmed.is_empty() {
                self.queued_messages.push(self.input.clone());
            }
            self.input.clear();
            self.autocomplete = None;
            return None;
        }
        let trimmed = self.input.trim();
        if trimmed.is_empty() {
            return None;
        }
        let content = self.input.clone();
        let wire_override = self.pending_wire_override.take();
        self.show_post_clear_splash = false;
        self.messages.push(DisplayMessage {
            role: OpenAiChatRole::User,
            content,
            wire_override,
            origin: DisplayOrigin::Transcript,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        self.input.clear();
        self.streaming = true;
        self.current_assistant_buffer.clear();
        self.last_error = None;
        self.request_started_at = Some(Instant::now());
        self.output_tokens = 0;
        self.cumulative_output_tokens = 0;
        self.thought_ms = 0;
        self.tip_rotation_index = self.tip_rotation_index.wrapping_add(1);
        self.autocomplete = None;
        self.scroll_to_bottom();
        self.turn_verb = Some(super::progress::pick_verb_for_turn(
            super::progress::next_turn_seed(),
        ));
        // Fresh turn, fresh tool-call list. Prior-turn tool calls live
        // on in the finalized assistant message that cited them; the
        // active vector is a per-turn scratch pad.
        self.active_tool_calls.clear();
        Some(self.history_for_request())
    }

    /// Register a new tool-call dispatch. Pushes a `Running` entry
    /// onto [`ConversationState::active_tool_calls`]. Called from the
    /// event loop when the agent task sends
    /// `StreamEvent::ToolCallStart`.
    ///
    /// For backgroundable tool kinds (Agent, Bash) also mirrors the
    /// tool-call into the [`crate::tasks::TaskStore`] so the footer
    /// pill, the Ctrl+B predicate, and the `/tasks` dialog surface
    /// the in-flight work while it dispatches. The store record's
    /// id is the tool-call id, so the completion path in
    /// [`Self::finish_tool_call`] can transition the same row.
    pub fn begin_tool_call(&mut self, id: String, name: String, args: Value) {
        if let Some(kind) = backgroundable_kind(&name) {
            let task_id = crate::tasks::TaskId::from_string(id.clone());
            let display_name = summarize_tool_invocation(&name, &args);
            let command = args.to_string();
            let mut record = match kind {
                crate::tasks::TaskKind::Shell => {
                    crate::tasks::TaskRecord::new_shell(task_id, display_name, command)
                }
                crate::tasks::TaskKind::Agent => {
                    crate::tasks::TaskRecord::new_agent(task_id, display_name, command)
                }
                crate::tasks::TaskKind::Generic => {
                    crate::tasks::TaskRecord::new_shell(task_id, display_name, command)
                }
            };
            record.state = crate::tasks::TaskState::Running;
            record.is_backgrounded = false;
            self.tasks.insert(record);
        }
        self.active_tool_calls.push(ToolCallEntry {
            id,
            name,
            args,
            status: ToolStatus::Running,
            payload: None,
            started_at: Instant::now(),
            elapsed_ms: 0,
            raw_result: None,
        });
    }

    /// Transition a Running entry to `Ok` / `Error` per `result`, stash
    /// the render payload, record `elapsed_ms`. Orphan `Finish` (no
    /// matching `Start` id) warns and drops the event — defensive
    /// against a race between cancellation and dispatch that shouldn't
    /// fire in practice but must never panic.
    pub fn finish_tool_call(
        &mut self,
        id: &str,
        result: Result<Value, String>,
        elapsed_ms: u64,
    ) {
        let entry = match self
            .active_tool_calls
            .iter_mut()
            .find(|e| e.id == id)
        {
            Some(e) => e,
            None => {
                tracing::warn!(
                    target: "otherside::tui",
                    id,
                    "finish_tool_call for unknown id — no matching Start"
                );
                return;
            }
        };
        entry.elapsed_ms = elapsed_ms;
        let verbose = self.render_verbose;
        let tool_name = entry.name.clone();
        match &result {
            Ok(value) => {
                entry.status = ToolStatus::Ok;
                entry.payload = tool_render::payload_from_result(&entry.name, value, verbose);
                entry.raw_result = Some(value.clone());
            }
            Err(err) => {
                entry.status = ToolStatus::Error;
                entry.payload = Some(tool_render::payload_from_error(err));
                entry.raw_result = None;
            }
        }
        // Mirror the transition into TaskStore when this tool was
        // registered as a backgroundable task. Completed / Failed
        // flows the same way regardless of whether the user hit
        // Ctrl+B — the store record closes out either way.
        if backgroundable_kind(&tool_name).is_some() {
            let task_id = crate::tasks::TaskId::from_string(id.to_string());
            self.tasks.update_with(&task_id, |r| {
                match &result {
                    Ok(_) => {
                        r.state = crate::tasks::TaskState::Completed;
                        r.exit_code = Some(0);
                    }
                    Err(_) => {
                        r.state = crate::tasks::TaskState::Failed;
                        r.exit_code = Some(1);
                    }
                }
                // Only flag injection when it was actually in the
                // background — otherwise the result already rode the
                // synchronous tool_result message and a duplicate
                // <task-notification> would confuse the model.
                if r.is_backgrounded {
                    r.inject_on_next_turn = true;
                }
            });
        }
    }

    /// Toggle the verbose render flag. Walks `active_tool_calls` and
    /// recomputes each entry's `payload` from `raw_result` so the new
    /// verbosity applies to both new AND existing in-flight entries.
    /// Called from the `/verbose` slash handler. Archived tool calls
    /// rendered from `Role::Tool` history are not touched — only live
    /// entries have a `raw_result` to recompute from.
    pub fn toggle_render_verbose(&mut self) -> bool {
        self.render_verbose = !self.render_verbose;
        for entry in self.active_tool_calls.iter_mut() {
            if let Some(raw) = &entry.raw_result {
                entry.payload =
                    tool_render::payload_from_result(&entry.name, raw, self.render_verbose);
            }
        }
        self.render_verbose
    }

    /// Suppress the autocomplete popup while a request is in flight.
    /// 011 fidelity rule: no slash popup while tools are dispatching —
    /// the popup would flash over the streaming output and mislead the
    /// user into thinking the input is still focused for slash entry.
    /// Recompute the autocomplete popup from the current input. Call
    /// after any input-buffer mutation so the popup opens/closes as
    /// the partial after `/` changes.
    pub fn refresh_autocomplete(&mut self) {
        if self.streaming {
            self.autocomplete = None;
            return;
        }
        self.autocomplete = Autocomplete::from_input(&self.input);
    }

    /// Close the popup without touching the input — used on Esc and
    /// after committing an entry.
    pub fn close_autocomplete(&mut self) {
        self.autocomplete = None;
    }

    /// Local handler for `/clear` — wipe messages, reset error state,
    /// clear input. Does NOT exit the TUI. Caller re-renders and the
    /// splash mascot comes back because `messages.is_empty()`.
    pub fn clear_conversation(&mut self) {
        self.messages.clear();
        self.current_assistant_buffer.clear();
        self.last_error = None;
        self.input.clear();
        self.autocomplete = None;
        self.scroll_offset = 0;
        // Zero the session-scoped token accounting so the info-row chip
        // matches the fresh-session state. Without this the chip stays
        // pinned at the pre-/clear cumulative total (bug #77).
        self.input_tokens = 0;
        self.output_tokens = 0;
        self.cumulative_output_tokens = 0;
        self.thought_ms = 0;
        // Signal the render layer to redraw the splash above the
        // `/clear` anchor. Cleared on the next user submit so the
        // splash doesn't survive into subsequent turns.
        self.show_post_clear_splash = true;
    }

    /// Surface an inline system note in the streaming area. Used by
    /// local slash dispatch (Rewind stub, Login/Logout hints, etc.)
    /// and by the streaming error surface.
    pub fn push_system_note(&mut self, text: impl Into<String>) {
        self.messages.push(DisplayMessage {
            role: OpenAiChatRole::System,
            content: text.into(),
            wire_override: None,
            origin: DisplayOrigin::Chrome,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        self.input.clear();
        self.autocomplete = None;
        self.scroll_to_bottom();
    }

    /// Append an anchor pair.
    ///
    /// Emits two messages:
    ///
    /// 1. a User turn `/<name> <args>` — renders with the `❯` chevron.
    /// 2. a System turn prefixed with `⎿ ` — the render layer spots
    ///    the prefix and paints the line dim + italic WITHOUT the
    ///    usual `system:` label, giving the upstream anchor shape.
    ///
    /// `origin` decides whether the pair reaches the provider on the
    /// next turn: `Transcript` for Anchor-category slashes (`/compact`,
    /// `/branch`, `/loop`, `/context`) whose semantics belong in the
    /// conversation; `Chrome` for Panel / Instant / Toggle / Auth
    /// dismissal echoes that must stay local.
    pub fn push_anchor(
        &mut self,
        slash_name: &str,
        args: &str,
        result: impl Into<String>,
        origin: DisplayOrigin,
    ) {
        let echo = if args.is_empty() {
            format!("/{slash_name}")
        } else {
            format!("/{slash_name} {args}")
        };
        self.messages.push(DisplayMessage {
            role: OpenAiChatRole::User,
            content: echo,
            wire_override: None,
            origin,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        self.messages.push(DisplayMessage {
            role: OpenAiChatRole::System,
            // Double-space after ⎿ mirrors upstream's uniform
            // anchor prefix across every captured surface (010
            // R-92 evidence: `/tmp/parity-20260420-tmux/**/upstream*.txt`).
            content: format!("⎿  {}", result.into()),
            wire_override: None,
            origin,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        self.input.clear();
        self.autocomplete = None;
        self.scroll_to_bottom();
    }

    /// Switch the active model mid-session. Accepts the same raw form
    /// the CLI takes (`claude-opus-4-7`, `claude-opus-4-7[1m]`,
    /// `opus[1m](xhigh)`). Re-sizes the context window based on the
    /// `[1m]` flag; the thinking suffix passes through untouched for
    /// the next request's parser.
    pub fn switch_model(&mut self, new_raw: &str) {
        self.session.set_model(new_raw);
    }

    /// `/compact` — drop finalized messages and surface a short
    /// placeholder so the user sees the session continued. Does NOT
    /// wipe input or autocomplete state (user may be mid-slash).
    pub fn compact_history(&mut self) {
        self.messages.clear();
        self.current_assistant_buffer.clear();
        self.input.clear();
        self.autocomplete = None;
        self.scroll_offset = 0;
        // Post-compact markers (the `✻ Conversation compacted …` header
        // and the `❯ /compact` + `⎿ Compacted …` anchor pair) are now
        // pushed by the slash handler in `slash::anchor::handle`,
        // openspec 002. `compact_history` just wipes — the caller owns
        // what the transcript looks like after the wipe.
    }

    /// Elapsed wall clock since the current request started, or 0 when
    /// idle. Convenience for the progress line render path.
    pub fn elapsed_ms(&self) -> u64 {
        match self.request_started_at {
            Some(t) => t.elapsed().as_millis() as u64,
            None => 0,
        }
    }

    /// Permission-mode chip spec for the info row. Returns `None` for
    /// `Default` because upstream gates the whole chip through
    /// `hasActiveMode` — an empty chip IS the correct state (see
    /// `components/PromptInput/PromptInputFooterLeftSide.tsx:360`).
    /// For every non-Default mode we emit the symbol glyph + lowercase
    /// label ("on" suffix) + a color-token discriminant the render
    /// layer resolves through the theme module. The `(shift+tab to
    /// cycle)` affordance is NOT appended here — render-site owns that
    /// suffix because visibility depends on competing chip count
    /// (upstream `primaryItemCount < 2` gate, same file line 349).
    ///
    /// Mode labels mirror `utils/permissions/PermissionMode.ts:41-86`
    /// with one otherside divergence: `Yolo` reads `yolo on` rather
    /// than `bypass permissions on`. Identity zone carries otherside's
    /// own vocabulary (R-01 / R-11) and `--yolo` is the canonical CLI
    /// flag per R-106; rendering upstream's literal string would be a
    /// gratuitous deviation from our own brand.
    pub fn permission_mode_label(&self) -> Option<PermissionChip> {
        use crate::config::PermissionMode as P;
        match self.session.permission_mode {
            P::Default => None,
            P::Plan => Some(PermissionChip {
                symbol: "⏸",
                text: "plan mode on".to_string(),
                color: ChipColor::PlanMode,
            }),
            P::AcceptEdits => Some(PermissionChip {
                symbol: "⏵⏵",
                text: "accept edits on".to_string(),
                color: ChipColor::AutoAccept,
            }),
            P::Yolo => Some(PermissionChip {
                symbol: "⏵⏵",
                text: "yolo on".to_string(),
                color: ChipColor::Error,
            }),
        }
    }

    /// Advance the permission mode to the next one in the cycle.
    /// Order: `Default → AcceptEdits → Plan → Yolo → Default`. Matches
    /// upstream `utils/permissions/getNextPermissionMode.ts:27-59`
    /// (external build, `bypassPermissions` after `plan`, no `auto` /
    /// `dontAsk`). Four-arm exhaustive match — compiler flags any new
    /// `PermissionMode` variant so the transition table can't silently
    /// regress back to the 3-mode collapse the audit caught (see
    /// `openspec/changes/016-permission-cycle-4-mode/` + R-104).
    pub fn cycle_permission_mode(&mut self) {
        self.session.cycle_permission_mode();
    }

    /// Auto-fire a turn whose user input is ONLY drained
    /// `<task-notification>` envelopes — no user-typed prompt. The
    /// event-loop tick calls this when (`!streaming &&
    /// input.is_empty() && store.has_pending_notifications()`) AND
    /// the user-queued head drain returned nothing (priority:
    /// queued user input `next` > notifications `later`).
    ///
    /// Returns `Some(history)` for the caller to dispatch when
    /// notifications were drained, `None` when the store had
    /// nothing pending (no-op, safe to call from any tick).
    ///
    /// Mirror of [`Self::submit`] side-effects on the streaming
    /// path (no input echo, no input clear — `input` is already
    /// empty when this is gated). Drained notifications are also
    /// appended to the session JSONL as `Record::UserMessage`
    /// entries so `--resume` reload reconstructs the conversation
    /// with the notification turns intact.
    pub fn submit_auto_notification_turn(
        &mut self,
        store: &crate::tasks::TaskStore,
    ) -> Option<Vec<OpenAiChatMessage>> {
        let count = self.consume_pending_notifications(store);
        if count == 0 {
            return None;
        }
        // Persist each synthetic notification user message to the
        // session JSONL so a `--resume` reload sees the same
        // history the model saw on the live wire. The freshly
        // pushed messages are the last `count` entries — pull
        // their content out + append a Record::UserMessage each.
        let new_msg_start = self.messages.len().saturating_sub(count);
        let to_persist: Vec<String> = self.messages[new_msg_start..]
            .iter()
            .map(|m| m.content.clone())
            .collect();
        for content in to_persist {
            self.append_record(crate::sessions::Record::UserMessage {
                ts: crate::sessions::record::now_iso(),
                content,
            });
        }
        // Mirror the relevant streaming-start side-effects of
        // submit() — without the input echo or input clear.
        self.streaming = true;
        self.current_assistant_buffer.clear();
        self.last_error = None;
        self.request_started_at = Some(Instant::now());
        self.output_tokens = 0;
        self.cumulative_output_tokens = 0;
        self.thought_ms = 0;
        self.tip_rotation_index = self.tip_rotation_index.wrapping_add(1);
        self.autocomplete = None;
        self.scroll_to_bottom();
        self.turn_verb = Some(super::progress::pick_verb_for_turn(
            super::progress::next_turn_seed(),
        ));
        self.active_tool_calls.clear();
        Some(self.history_for_request())
    }

    /// Drain every record in `store` flagged
    /// `inject_on_next_turn = true`, render each as a
    /// `<task-notification>` XML envelope (with `<tool-use-id>` from
    /// the record), and push one synthetic user `DisplayMessage` per
    /// drained record. Returns the count drained.
    ///
    /// Synthetic rows ride the wire (`history_for_request` includes
    /// them) but the render layer skips them — match upstream's
    /// queue-injected `task-notification` items, which the model
    /// sees as user turns but the user never types.
    ///
    /// Idempotent: a second call after a successful drain finds no
    /// pendings and returns 0. Safe to poll from the event-loop tick
    /// without locking churn (the cheap [`crate::tasks::TaskStore::has_pending_notifications`]
    /// gate is the recommended pre-check).
    ///
    /// Mirrors upstream `enqueuePendingNotification` →
    /// `processQueueIfReady` → `executeInput` chain
    /// (`utils/queueProcessor.ts:33-87`,
    /// `tasks/LocalAgentTask/LocalAgentTask.tsx:247-262`).
    pub fn consume_pending_notifications(
        &mut self,
        store: &crate::tasks::TaskStore,
    ) -> usize {
        let drained = store.drain_pending_notifications();
        if drained.is_empty() {
            return 0;
        }
        let count = drained.len();
        for record in drained {
            let output_path = format!("~/.otherside/tasks/{}.log", record.id.as_str());
            let extras = crate::harness::task_notification::NotificationExtras {
                tool_use_id: record.tool_use_id.as_deref(),
                ..Default::default()
            };
            let xml = crate::harness::task_notification::render(
                &record,
                &output_path,
                extras,
            );
            self.messages.push(DisplayMessage {
                role: OpenAiChatRole::User,
                content: xml,
                wire_override: None,
                origin: DisplayOrigin::Transcript,
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_synthetic: true,
            });
        }
        count
    }

    /// Snapshot `messages` as a `Vec<OpenAiChatMessage>` suitable for the
    /// canonical request. Kept separate from [`submit`](Self::submit) so
    /// tests and future slash commands can peek without side-effects.
    ///
    /// `Role::Tool` rows carry a JSON-serialized [`tool_render::ToolCallArchive`]
    /// (the same shape the local render layer reads). For wire output,
    /// each archive expands into the canonical OpenAI shape — one
    /// `Role::Assistant` carrying a `tool_calls` entry, then one
    /// `Role::Tool` with the matching `tool_call_id` and the raw
    /// dispatcher result as content. The translator turns those into
    /// the Anthropic `tool_use` / `tool_result` block pair upstream
    /// expects (`tasks/LocalAgentTask/LocalAgentTask.tsx:247-257`,
    /// `tools/AgentTool/AgentTool.tsx:1339-1351`). Without this
    /// reconstruction the model loses every tool_use_id across turn
    /// boundaries — fatal for backgrounded `Agent` dispatches whose
    /// `<task-notification>` reconciliation depends on the LLM
    /// matching `<tool-use-id>` against its own prior tool_use block.
    pub fn history_for_request(&self) -> Vec<OpenAiChatMessage> {
        let mut out: Vec<OpenAiChatMessage> = Vec::with_capacity(self.messages.len());
        for m in &self.messages {
            if m.origin != DisplayOrigin::Transcript {
                continue;
            }
            if m.role == OpenAiChatRole::Tool {
                // Reconstruct the assistant tool_use + user tool_result
                // pair from the archived ToolCallArchive. Older
                // archives (pre-id/raw_result fields) fall back to the
                // legacy single-Tool emission so historical sessions
                // don't break — degraded fidelity, but no crash.
                if let Ok(archive) =
                    serde_json::from_str::<tool_render::ToolCallArchive>(&m.content)
                {
                    if !archive.id.is_empty() {
                        let args_json =
                            serde_json::to_string(&archive.args).unwrap_or_else(|_| "{}".into());
                        out.push(OpenAiChatMessage {
                            role: OpenAiChatRole::Assistant,
                            content: String::new(),
                            name: None,
                            tool_calls: vec![crate::inference::OpenAiToolCall {
                                id: archive.id.clone(),
                                kind: "function".into(),
                                function: crate::inference::OpenAiToolCallFunction {
                                    name: archive.name.clone(),
                                    arguments: args_json,
                                },
                            }],
                            tool_call_id: None,
                        });
                        let result_text = match &archive.raw_result {
                            Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "{}".into()),
                            None => m.content.clone(),
                        };
                        out.push(OpenAiChatMessage {
                            role: OpenAiChatRole::Tool,
                            content: result_text,
                            name: None,
                            tool_calls: Vec::new(),
                            tool_call_id: Some(archive.id),
                        });
                        continue;
                    }
                }
                // Legacy / unparseable archive: emit a degraded
                // user-text fallback so the model still sees a
                // breadcrumb (without tool_use it can't reconcile a
                // later notification, but at least history doesn't
                // silently drop the row).
                out.push(OpenAiChatMessage {
                    role: OpenAiChatRole::User,
                    content: m
                        .wire_override
                        .clone()
                        .unwrap_or_else(|| m.content.clone()),
                    name: None,
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
                continue;
            }
            out.push(OpenAiChatMessage {
                role: m.role,
                content: m
                    .wire_override
                    .clone()
                    .unwrap_or_else(|| m.content.clone()),
                name: None,
                tool_calls: m.tool_calls.clone(),
                tool_call_id: m.tool_call_id.clone(),
            });
        }
        out
    }

    /// Overwrite whichever of `input_tokens` / `output_tokens` is
    /// `Some` in the argument, leaving the other field untouched.
    /// Mirror upstream's `updateProgressFromMessage` semantics from
    /// `tasks/LocalAgentTask/LocalAgentTask.tsx:73-75`:
    ///
    /// ```text
    /// tracker.latestInputTokens  = usage.input_tokens + cache_creation + cache_read;
    /// tracker.cumulativeOutputTokens += usage.output_tokens;
    /// ```
    ///
    /// - **Input** REPLACES — the API's `input_tokens` is already
    ///   cumulative for the turn (cache-creation / cache-read adders
    ///   are folded in upstream of this call at the translator).
    ///   An `input_tokens` update ALSO signals a new assistant
    ///   message is starting: Anthropic's SSE fires one `message_start`
    ///   per assistant message, and that's the only carrier of input
    ///   usage. When we see one with non-zero `output_tokens` still
    ///   in state, the prior message's final output count folds into
    ///   `cumulative_output_tokens` and `output_tokens` resets to 0.
    /// - **Output** is REPLACED — Anthropic's `message_delta` fires
    ///   once per message at the end, carrying the final cumulative
    ///   output count for that message. Within a message there's only
    ///   one datapoint, so REPLACE is correct (not `+=`). Across
    ///   messages, the input-side fold above archives the prior value
    ///   before it gets overwritten.
    ///
    /// Why not fold on an output-side DROP instead? Anthropic delivers
    /// exactly one `message_delta.usage` per message, at the end. The
    /// next message's first (and only) `message_delta` often has a
    /// higher output_tokens than the prior message's, so a drop-based
    /// fold silently loses sub-turn output across tool-call chains.
    /// The `message_start` signal is the reliable boundary.
    pub fn update_usage(&mut self, input_tokens: Option<u64>, output_tokens: Option<u64>) {
        if let Some(v) = input_tokens {
            // New message boundary — archive the prior message's
            // final output count before the next message starts
            // accruing from 0.
            if self.output_tokens > 0 {
                self.cumulative_output_tokens = self
                    .cumulative_output_tokens
                    .saturating_add(self.output_tokens);
                self.output_tokens = 0;
            }
            self.input_tokens = v;
        }
        if let Some(v) = output_tokens {
            self.output_tokens = v;
        }
    }

    /// Total output tokens used across the whole agent turn /
    /// tool-call chain — the cumulative bucket of finalized prior
    /// messages plus the current message's running count. The
    /// progress line calls this so `↓ Nk tokens` reflects the full
    /// agent-loop output pressure, not just the latest sub-turn.
    pub fn total_output_tokens(&self) -> u64 {
        self.cumulative_output_tokens
            .saturating_add(self.output_tokens)
    }

    /// Append a chunk's content delta onto the in-flight assistant buffer.
    /// Called from the event loop on every [`crate::inference::OpenAiChunk`]
    /// whose `delta.content` is non-empty. Auto-follows the latest output
    /// ONLY when the user hasn't scrolled back — otherwise respect their
    /// viewport so reading history during streaming survives deltas.
    pub fn append_stream_delta(&mut self, delta: &str) {
        // The first visible text delta marks the end of any
        // upstream-side thinking phase — wall clock between turn
        // start and this moment is the thinking time the progress
        // line surfaces as "thought for Xs". Freeze on first delta
        // so later deltas don't keep bumping the count.
        if self.thought_ms == 0 {
            if let Some(started) = self.request_started_at {
                let elapsed = started.elapsed().as_millis() as u64;
                if elapsed > 0 {
                    self.thought_ms = elapsed;
                }
            }
        }
        self.current_assistant_buffer.push_str(delta);
        // Tail-follow honors the user's scroll intent — only pin the
        // newest delta into view when sticky_bottom is still true.
        if self.sticky_bottom {
            self.scroll_offset = 0;
        }
    }

    /// Finalize the current stream. Promotes the assistant buffer (if
    /// non-empty) into a permanent [`DisplayMessage`], then flips
    /// `streaming = false`.
    ///
    /// An empty buffer is dropped silently — some requests finish with no
    /// content (e.g. a 200 with only tool-use blocks, which the MVP
    /// doesn't surface yet).
    pub fn finish_stream(&mut self) {
        // Archive this turn's tool calls into the message log BEFORE
        // the assistant-text promotion. Order = insertion = upstream
        // transcript order (tool calls precede the summary reply).
        // Without this the active_tool_calls render band paints AFTER
        // the promoted assistant message, inverting the flow, and the
        // entries vanish on the next submit (when active_tool_calls
        // clears). Serialized as Role::Tool so history_for_request
        // can filter them back out before hitting the API.
        for entry in std::mem::take(&mut self.active_tool_calls) {
            self.messages.push(DisplayMessage {
                role: OpenAiChatRole::Tool,
                content: format_tool_history_entry(&entry),
                wire_override: None,
                origin: DisplayOrigin::Transcript,
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_synthetic: false,
            });
        }
        if !self.current_assistant_buffer.is_empty() {
            let content = std::mem::take(&mut self.current_assistant_buffer);
            self.messages.push(DisplayMessage {
                role: OpenAiChatRole::Assistant,
                content,
                wire_override: None,
                origin: DisplayOrigin::Transcript,
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_synthetic: false,
            });
        } else {
            self.current_assistant_buffer.clear();
        }
        self.streaming = false;
        self.request_started_at = None;
        self.turn_verb = None;
        self.turn_task = None;
        // Do NOT yank the viewport — honor the user's scroll intent
        // across turn boundaries. Upstream REPL.tsx:1284-1301 leaves
        // scroll position untouched on completion.
    }

    /// Record an error reported by the provider.
    ///
    /// Any partial assistant text already accumulated is promoted into a
    /// permanent message so the user can see what landed before the
    /// failure; the error text itself is stored in `last_error` for the
    /// render layer to show inline. `streaming` flips back to false so the
    /// input box accepts keys again.
    pub fn fail_stream(&mut self, err: String) {
        // Same archival as finish_stream — preserve tool-call history
        // across the failure boundary.
        for entry in std::mem::take(&mut self.active_tool_calls) {
            self.messages.push(DisplayMessage {
                role: OpenAiChatRole::Tool,
                content: format_tool_history_entry(&entry),
                wire_override: None,
                origin: DisplayOrigin::Transcript,
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_synthetic: false,
            });
        }
        if !self.current_assistant_buffer.is_empty() {
            let content = std::mem::take(&mut self.current_assistant_buffer);
            self.messages.push(DisplayMessage {
                role: OpenAiChatRole::Assistant,
                content,
                wire_override: None,
                origin: DisplayOrigin::Transcript,
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_synthetic: false,
            });
        }
        self.last_error = Some(err);
        self.streaming = false;
        self.request_started_at = None;
        self.turn_verb = None;
        self.turn_task = None;
        // See finish_stream — scroll position is user intent.
    }

    /// Cancel an in-flight turn. Aborts the spawn task, promotes any
    /// partial assistant content so the user sees what landed before
    /// the interrupt, flips streaming off, and appends an inline
    /// muted note. No-op when idle.
    ///
    /// Returns `true` when a running turn was actually cancelled —
    /// callers use this to decide between "cancel was enough" and
    /// "escalate to exit handling".
    pub fn cancel_stream(&mut self) -> bool {
        if !self.streaming {
            return false;
        }
        if let Some(handle) = self.turn_task.take() {
            handle.abort();
        }
        if !self.current_assistant_buffer.is_empty() {
            let content = std::mem::take(&mut self.current_assistant_buffer);
            self.messages.push(DisplayMessage {
                role: OpenAiChatRole::Assistant,
                content,
                wire_override: None,
                origin: DisplayOrigin::Transcript,
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_synthetic: false,
            });
        }
        self.streaming = false;
        self.request_started_at = None;
        self.turn_verb = None;
        self.push_system_note("cancelled");
        true
    }

    /// Arm the double-press-to-exit window. `key_label` is the human
    /// name of the triggering key (`"Ctrl+C"` / `"Ctrl+D"`). On the
    /// second press within `EXIT_DOUBLE_PRESS_MS`, `exit_confirmed`
    /// returns true and the caller exits.
    pub fn arm_exit_confirmation(&mut self, key_label: &'static str) {
        self.exit_armed_at = Some(Instant::now());
        self.exit_armed_key = Some(key_label);
    }

    /// True when a prior `arm_exit_confirmation` is still inside the
    /// double-press window. The caller should exit immediately.
    pub fn exit_confirmed(&self) -> bool {
        self.exit_armed_at
            .map(|t| t.elapsed().as_millis() < EXIT_DOUBLE_PRESS_MS as u128)
            .unwrap_or(false)
    }

    /// Clear the arm timer — called on any non-exit key so stray
    /// Ctrl+C presses don't leak past their window.
    pub fn clear_exit_armed(&mut self) {
        self.exit_armed_at = None;
        self.exit_armed_key = None;
    }

    /// Drop the input buffer — used by Esc when no stream is running
    /// + no autocomplete popup is open. Upstream `PromptInput`
    /// clears on Esc even without an active turn.
    pub fn clear_input(&mut self) {
        self.input.clear();
        self.autocomplete = None;
    }

    // ----- 017 §4 message queue ---------------------------------------

    /// Append `msg` to the tail of [`queued_messages`]. Called from
    /// `handle_key`'s Enter arm when the stream is live; also
    /// invoked indirectly via [`submit`] when called during streaming
    /// (the dual entry point keeps the direct push available for
    /// tests that bypass submit's streaming guard).
    pub fn push_to_queue(&mut self, msg: String) {
        self.queued_messages.push(msg);
    }

    /// Pop the FIFO head of [`queued_messages`]. Used by the event
    /// loop's auto-submit path on `finish_stream` / `fail_stream` —
    /// upstream's `popCommandFromQueue` semantic (head-first drain).
    /// `None` when empty. O(N) removal is unmeasurable at the
    /// human-typed queue sizes we expect (design.md §4.3).
    pub fn pop_queue_head(&mut self) -> Option<String> {
        if self.queued_messages.is_empty() {
            None
        } else {
            Some(self.queued_messages.remove(0))
        }
    }

    /// Pop the LIFO tail of [`queued_messages`]. Used by the Up-arrow
    /// "edit most-recent queued message" affordance — the user's
    /// intent is "fix what I just typed," so the tail is the right
    /// end (design.md "Decision: Up-arrow restores the queue TAIL").
    /// `None` when empty.
    pub fn pop_queue_tail(&mut self) -> Option<String> {
        self.queued_messages.pop()
    }

    /// `true` when the queue has at least one entry. Drives the
    /// prompt-bar chip's visibility in the render layer.
    pub fn has_queued_messages(&self) -> bool {
        !self.queued_messages.is_empty()
    }

    /// Pop the head of the queue into [`input`]. Returns `true` when
    /// a head was consumed (so the caller can proceed to [`submit`]),
    /// `false` when the queue was empty. Pure state helper — the
    /// event loop calls this inside its `Done` / `Error` / channel-
    /// closed arms, after `finish_stream` / `fail_stream` flipped
    /// `streaming` off, so that the subsequent `submit()` re-enters
    /// the streaming path with the queued content.
    pub fn consume_queue_head_into_input(&mut self) -> bool {
        match self.pop_queue_head() {
            Some(head) => {
                self.input = head;
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_for_model_picks_1m_when_suffix_present() {
        let st = ConversationState::new_for_model("claude-opus-4-7[1m]");
        assert_eq!(st.session.context_window, 1_000_000);
        assert_eq!(st.context_window_label(), "1M");
    }

    #[test]
    fn new_for_model_defaults_to_200k() {
        let st = ConversationState::new_for_model("claude-opus-4-7");
        assert_eq!(st.session.context_window, 200_000);
        assert_eq!(st.context_window_label(), "200K");
    }

    #[test]
    fn new_for_model_is_case_insensitive() {
        let st = ConversationState::new_for_model("OPUS[1M]");
        assert_eq!(st.session.context_window, 1_000_000);
    }

    #[test]
    fn empty_input_is_not_submittable() {
        // A bare Enter with empty input must be a no-op — matches the
        // idiomatic chat-box contract and avoids emitting zero-char user
        // turns to the provider.
        let mut st = ConversationState::new();
        assert!(st.submit().is_none());
        assert_eq!(st.messages.len(), 0);
        assert!(!st.streaming);
    }

    #[test]
    fn whitespace_only_input_is_not_submittable() {
        // `"   \n  "` is visually empty; trim check catches it.
        let mut st = ConversationState::new();
        st.input = "   \n  ".to_string();
        assert!(st.submit().is_none());
        assert_eq!(st.messages.len(), 0);
    }

    #[test]
    fn submit_pushes_user_message_and_flips_streaming() {
        let mut st = ConversationState::new();
        st.input = "hello".to_string();
        let history = st.submit().expect("non-empty input should submit");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].role, OpenAiChatRole::User);
        assert_eq!(history[0].content, "hello");
        assert_eq!(st.messages.len(), 1);
        assert!(st.streaming);
        assert_eq!(st.input, "");
    }

    #[test]
    fn second_submit_rejected_while_streaming() {
        // Safety: user hitting Enter again while we're still waiting must
        // not fire a second concurrent request.
        let mut st = ConversationState::new();
        st.input = "first".to_string();
        assert!(st.submit().is_some());
        st.input = "second".to_string();
        assert!(st.submit().is_none());
        assert_eq!(st.messages.len(), 1);
    }

    #[test]
    fn stream_deltas_accumulate_then_finalize() {
        let mut st = ConversationState::new();
        st.input = "hi".to_string();
        st.submit().unwrap();
        st.append_stream_delta("He");
        st.append_stream_delta("llo");
        assert_eq!(st.current_assistant_buffer, "Hello");
        st.finish_stream();
        assert!(!st.streaming);
        assert_eq!(st.current_assistant_buffer, "");
        assert_eq!(st.messages.len(), 2);
        assert_eq!(st.messages[1].role, OpenAiChatRole::Assistant);
        assert_eq!(st.messages[1].content, "Hello");
    }

    #[test]
    fn empty_stream_does_not_push_empty_assistant() {
        // Finishing a stream that produced zero content should not leave a
        // blank assistant bubble in the log.
        let mut st = ConversationState::new();
        st.input = "hi".to_string();
        st.submit().unwrap();
        st.finish_stream();
        assert_eq!(st.messages.len(), 1);
    }

    #[test]
    fn fail_stream_records_error_and_keeps_partial_content() {
        let mut st = ConversationState::new();
        st.input = "hi".to_string();
        st.submit().unwrap();
        st.append_stream_delta("par");
        st.fail_stream("network exploded".to_string());
        assert!(!st.streaming);
        assert_eq!(st.last_error.as_deref(), Some("network exploded"));
        // Partial content preserved as assistant message.
        assert_eq!(st.messages.len(), 2);
        assert_eq!(st.messages[1].content, "par");
    }

    #[test]
    fn scroll_saturates_at_zero() {
        let mut st = ConversationState::new();
        st.scroll_down(10);
        assert_eq!(st.scroll_offset, 0);
        st.scroll_up(5);
        assert_eq!(st.scroll_offset, 5);
        st.scroll_down(3);
        assert_eq!(st.scroll_offset, 2);
    }

    #[test]
    fn history_round_trip_has_all_turns() {
        // After two user/assistant cycles, history should carry four
        // messages in strict insertion order — the next request carries
        // the full conversation.
        let mut st = ConversationState::new();
        st.input = "first".to_string();
        st.submit().unwrap();
        st.append_stream_delta("one");
        st.finish_stream();

        st.input = "second".to_string();
        let history = st.submit().unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[0].content, "first");
        assert_eq!(history[1].content, "one");
        assert_eq!(history[2].content, "second");
    }

    #[test]
    fn new_submit_clears_previous_error() {
        // Once the user types something and submits again, the stale red
        // banner should disappear.
        let mut st = ConversationState::new();
        st.input = "hi".to_string();
        st.submit().unwrap();
        st.fail_stream("boom".to_string());
        assert!(st.last_error.is_some());

        st.input = "retry".to_string();
        st.submit().unwrap();
        assert!(st.last_error.is_none());
    }

    #[test]
    fn shift_enter_inserts_literal_newline() {
        // Shift+Enter is "newline in input"; Enter (later) is "submit".
        let mut st = ConversationState::new();
        st.input_push_char('a');
        st.input_push_newline();
        st.input_push_char('b');
        assert_eq!(st.input, "a\nb");
    }

    #[test]
    fn autocomplete_refresh_is_no_op_while_streaming() {
        // 011 fidelity: no popup while a request is in flight. Prevents
        // the slash catalog from flashing over streaming output and
        // misleading the user about input focus.
        let mut st = ConversationState::new();
        st.input = "/cle".to_string();
        st.refresh_autocomplete();
        assert!(
            st.autocomplete.is_some(),
            "autocomplete should be present when idle"
        );
        st.input = "hi".to_string();
        st.submit().unwrap();
        assert!(st.streaming);
        st.input = "/cle".to_string();
        st.refresh_autocomplete();
        assert!(
            st.autocomplete.is_none(),
            "autocomplete must be suppressed while streaming"
        );
    }

    #[test]
    fn autocomplete_returns_when_stream_finishes() {
        let mut st = ConversationState::new();
        st.input = "hi".to_string();
        st.submit().unwrap();
        st.append_stream_delta("ok");
        st.finish_stream();
        st.input = "/cle".to_string();
        st.refresh_autocomplete();
        assert!(st.autocomplete.is_some());
    }

    #[test]
    fn streaming_delta_appears_before_stream_end() {
        // Render path reads current_assistant_buffer while streaming —
        // the delta must be visible BEFORE finish_stream promotes it.
        let mut st = ConversationState::new();
        st.input = "hi".to_string();
        st.submit().unwrap();
        st.append_stream_delta("hello");
        assert_eq!(st.current_assistant_buffer, "hello");
        assert!(st.streaming);
    }

    #[test]
    fn scroll_up_sticks_through_deltas() {
        // User scrolled up while a stream is live — subsequent deltas
        // keep arriving but must NOT yank the viewport back to the
        // bottom. sticky_bottom flips false on scroll_up and survives
        // append_stream_delta calls.
        let mut st = ConversationState::new();
        st.input = "ask".to_string();
        st.submit().unwrap();
        st.scroll_up(5);
        assert!(!st.sticky_bottom);
        for _ in 0..10 {
            st.append_stream_delta("x");
        }
        assert_eq!(st.scroll_offset, 5);
        assert!(!st.sticky_bottom);
    }

    #[test]
    fn scroll_down_to_zero_restores_sticky() {
        let mut st = ConversationState::new();
        st.scroll_up(5);
        assert!(!st.sticky_bottom);
        st.scroll_down(5);
        assert_eq!(st.scroll_offset, 0);
        assert!(st.sticky_bottom);
    }

    #[test]
    fn finish_stream_does_not_override_scroll() {
        // Upstream REPL.tsx:1284-1301 leaves scroll untouched on
        // completion — otherside mirrors.
        let mut st = ConversationState::new();
        st.input = "x".to_string();
        st.submit().unwrap();
        st.scroll_up(5);
        st.append_stream_delta("partial");
        st.finish_stream();
        assert_eq!(st.scroll_offset, 5);
        assert!(!st.sticky_bottom);
    }

    #[test]
    fn fail_stream_does_not_override_scroll() {
        let mut st = ConversationState::new();
        st.input = "x".to_string();
        st.submit().unwrap();
        st.scroll_up(5);
        st.append_stream_delta("partial");
        st.fail_stream("boom".to_string());
        assert_eq!(st.scroll_offset, 5);
        assert!(!st.sticky_bottom);
    }

    #[test]
    fn submit_re_engages_sticky_bottom() {
        // Even if the user was scrolled up, a new submit intentionally
        // snaps the viewport back to the newest turn.
        let mut st = ConversationState::new();
        st.input = "one".to_string();
        st.submit().unwrap();
        st.scroll_up(3);
        st.finish_stream();
        st.input = "two".to_string();
        st.submit().unwrap();
        assert_eq!(st.scroll_offset, 0);
        assert!(st.sticky_bottom);
    }

    #[test]
    fn turn_verb_seeded_on_submit_and_cleared_on_finish() {
        let mut st = ConversationState::new();
        st.input = "ask".to_string();
        st.submit().unwrap();
        assert!(st.turn_verb.is_some());
        st.finish_stream();
        assert!(st.turn_verb.is_none());
    }

    #[test]
    fn update_usage_on_fresh_state_sets_input_only() {
        // First `message_start` of a user turn arrives with
        // `output_tokens == 0` (just been reset by `submit()`). Must
        // set input and leave output / cumulative at zero.
        let mut st = ConversationState::new();
        assert_eq!(st.output_tokens, 0);
        st.update_usage(Some(1234), None);
        assert_eq!(st.input_tokens, 1234);
        assert_eq!(st.output_tokens, 0);
        assert_eq!(st.cumulative_output_tokens, 0);
    }

    #[test]
    fn update_usage_input_update_archives_prior_output() {
        // An `input_tokens` update signals a new assistant message
        // is starting (Anthropic's `message_start`). The prior
        // message's final `output_tokens` folds into cumulative so
        // the turn-wide count survives into the next sub-turn.
        let mut st = ConversationState::new();
        st.update_usage(Some(1000), None); // sub-turn 1 start
        st.update_usage(None, Some(42)); // sub-turn 1 final
        st.update_usage(Some(1200), None); // sub-turn 2 start
        assert_eq!(st.input_tokens, 1200);
        assert_eq!(st.output_tokens, 0, "output resets on boundary");
        assert_eq!(st.cumulative_output_tokens, 42, "prior output archived");
    }

    #[test]
    fn update_usage_replaces_output_within_message() {
        // Anthropic's `message_delta` carries the FINAL output count
        // for that message (single event at end of message, not
        // running deltas). Within a message there's at most one
        // output update — REPLACE, not accumulate.
        let mut st = ConversationState::new();
        st.input_tokens = 555;
        st.update_usage(None, Some(77));
        assert_eq!(st.output_tokens, 77);
        assert_eq!(st.cumulative_output_tokens, 0);
        // Defensive: a second output-only update (rare) still replaces.
        st.update_usage(None, Some(140));
        assert_eq!(st.output_tokens, 140);
        assert_eq!(st.cumulative_output_tokens, 0);
        assert_eq!(st.input_tokens, 555, "input side must be untouched");
    }

    #[test]
    fn update_usage_folds_prior_output_on_new_message_start() {
        // Boundary between sub-turns in a tool-call chain is marked
        // by a fresh `message_start` (carrier of input_tokens). On
        // that boundary the prior message's final output folds into
        // `cumulative_output_tokens` and `output_tokens` resets to
        // 0 so the new message accrues from scratch. This is the
        // regression guard for the bug where tool-chain sub-turn
        // output silently dropped (the prior drop-based heuristic
        // fired only when N2 < N1, but message_delta fires once
        // per message, so in-practice N2 often >= N1).
        let mut st = ConversationState::new();
        // Sub-turn 1.
        st.update_usage(Some(10_000), None); // message_start
        st.update_usage(None, Some(200)); // message_delta final
        assert_eq!(st.output_tokens, 200);
        assert_eq!(st.cumulative_output_tokens, 0);
        // Sub-turn 2 starts — new message_start with input update.
        st.update_usage(Some(12_000), None);
        assert_eq!(
            st.output_tokens, 0,
            "output resets on new-message boundary"
        );
        assert_eq!(
            st.cumulative_output_tokens, 200,
            "prior message's output folded"
        );
        assert_eq!(st.input_tokens, 12_000);
        st.update_usage(None, Some(540)); // sub-turn 2 final — higher than N1
        assert_eq!(st.output_tokens, 540);
        assert_eq!(st.cumulative_output_tokens, 200);
        assert_eq!(st.total_output_tokens(), 740, "turn-wide output preserved");
    }

    #[test]
    fn update_usage_total_preserves_output_across_tool_chain() {
        // Regression: before the input-start fold, a three-sub-turn
        // tool chain with monotonically-growing output_tokens per
        // message lost every prior sub-turn's output (cumulative
        // stayed at 0). The progress-line `↓ Nk tokens` then
        // UNDER-reported the turn-wide output. Assert the full
        // chain now preserves every sub-turn.
        let mut st = ConversationState::new();
        // Sub-turn 1 — tool call, small output (just the JSON).
        st.update_usage(Some(20_000), None);
        st.update_usage(None, Some(50));
        // Sub-turn 2 — another tool call, slightly larger.
        st.update_usage(Some(21_000), None);
        st.update_usage(None, Some(120));
        // Sub-turn 3 — final assistant reply.
        st.update_usage(Some(23_000), None);
        st.update_usage(None, Some(540));
        assert_eq!(st.cumulative_output_tokens, 50 + 120);
        assert_eq!(st.output_tokens, 540);
        assert_eq!(st.total_output_tokens(), 50 + 120 + 540);
    }

    #[test]
    fn update_usage_no_op_when_both_none() {
        let mut st = ConversationState::new();
        st.input_tokens = 100;
        st.output_tokens = 200;
        st.update_usage(None, None);
        assert_eq!(st.input_tokens, 100);
        assert_eq!(st.output_tokens, 200);
    }

    #[test]
    fn turn_verb_cleared_on_fail_stream() {
        let mut st = ConversationState::new();
        st.input = "ask".to_string();
        st.submit().unwrap();
        assert!(st.turn_verb.is_some());
        st.fail_stream("network".to_string());
        assert!(st.turn_verb.is_none());
    }

    #[test]
    fn turn_verb_stable_within_turn() {
        // The spinner ticker mutates no state that affects turn_verb —
        // holding the value across arbitrary events is the load-bearing
        // invariant tested here.
        let mut st = ConversationState::new();
        st.input = "ask".to_string();
        st.submit().unwrap();
        let v0 = st.turn_verb;
        for _ in 0..100 {
            st.append_stream_delta("x");
        }
        assert_eq!(st.turn_verb, v0);
    }

    // ----- Permission mode cycle (016) -----

    #[test]
    fn cycle_permission_mode_three_visible_stops() {
        // Visible Shift+Tab cycle has 3 stops: AcceptEdits → Plan →
        // Yolo → AcceptEdits. `Default` (ask-before-edit) is hidden
        // from the TUI cycle — reachable via Settings / programmatic
        // path only.
        use crate::config::PermissionMode as P;
        let mut st = ConversationState::new();
        st.session.permission_mode = P::AcceptEdits;
        st.cycle_permission_mode();
        assert_eq!(st.session.permission_mode, P::Plan);
        st.cycle_permission_mode();
        assert_eq!(st.session.permission_mode, P::Yolo);
        st.cycle_permission_mode();
        assert_eq!(st.session.permission_mode, P::AcceptEdits);
    }

    #[test]
    fn cycle_permission_mode_from_hidden_default_lands_on_accept() {
        use crate::config::PermissionMode as P;
        let mut st = ConversationState::new();
        st.session.permission_mode = P::Default;
        st.cycle_permission_mode();
        assert_eq!(st.session.permission_mode, P::AcceptEdits);
    }

    #[test]
    fn cycle_permission_mode_from_accept_edits_goes_to_plan() {
        use crate::config::PermissionMode as P;
        let mut st = ConversationState::new();
        st.session.permission_mode = P::AcceptEdits;
        st.cycle_permission_mode();
        assert_eq!(st.session.permission_mode, P::Plan);
    }

    #[test]
    fn cycle_permission_mode_from_plan_goes_to_yolo() {
        use crate::config::PermissionMode as P;
        let mut st = ConversationState::new();
        st.session.permission_mode = P::Plan;
        st.cycle_permission_mode();
        assert_eq!(st.session.permission_mode, P::Yolo);
    }

    #[test]
    fn cycle_permission_mode_from_yolo_returns_to_accept_edits() {
        use crate::config::PermissionMode as P;
        let mut st = ConversationState::new();
        st.session.permission_mode = P::Yolo;
        st.cycle_permission_mode();
        assert_eq!(st.session.permission_mode, P::AcceptEdits);
    }

    #[test]
    fn permission_mode_label_default_returns_none() {
        // Upstream `hasActiveMode` gate collapses the chip for Default —
        // absence is the correct render state.
        let st = ConversationState::new();
        assert_eq!(st.session.permission_mode, crate::config::PermissionMode::Default);
        assert!(st.permission_mode_label().is_none());
    }

    #[test]
    fn permission_mode_label_plan_returns_pause_chip() {
        use crate::config::PermissionMode as P;
        let mut st = ConversationState::new();
        st.session.permission_mode = P::Plan;
        let chip = st.permission_mode_label().expect("plan chip");
        assert_eq!(chip.symbol, "⏸");
        assert_eq!(chip.text, "plan mode on");
        assert_eq!(chip.color, ChipColor::PlanMode);
    }

    #[test]
    fn permission_mode_label_accept_edits_returns_chevron_chip() {
        use crate::config::PermissionMode as P;
        let mut st = ConversationState::new();
        st.session.permission_mode = P::AcceptEdits;
        let chip = st.permission_mode_label().expect("accept edits chip");
        assert_eq!(chip.symbol, "⏵⏵");
        assert_eq!(chip.text, "accept edits on");
        assert_eq!(chip.color, ChipColor::AutoAccept);
    }

    #[test]
    fn permission_mode_label_yolo_returns_chevron_chip() {
        use crate::config::PermissionMode as P;
        let mut st = ConversationState::new();
        st.session.permission_mode = P::Yolo;
        let chip = st.permission_mode_label().expect("yolo chip");
        assert_eq!(chip.symbol, "⏵⏵");
        // Identity-zone brand wins over upstream literal `bypass
        // permissions on` — matches R-106 + C69.
        assert_eq!(chip.text, "yolo on");
        assert_eq!(chip.color, ChipColor::Error);
    }

    // --- 015 tool-call surface -------------------------------------------

    #[test]
    fn begin_tool_call_pushes_running_entry() {
        let mut st = ConversationState::new();
        st.begin_tool_call(
            "tc1".into(),
            "Read".into(),
            serde_json::json!({ "file": "x.rs" }),
        );
        assert_eq!(st.active_tool_calls.len(), 1);
        let entry = &st.active_tool_calls[0];
        assert_eq!(entry.id, "tc1");
        assert_eq!(entry.name, "Read");
        assert_eq!(entry.status, ToolStatus::Running);
        assert!(entry.payload.is_none());
        assert_eq!(entry.elapsed_ms, 0);
    }

    #[test]
    fn finish_tool_call_ok_transitions_status() {
        let mut st = ConversationState::new();
        st.begin_tool_call("tc1".into(), "Read".into(), serde_json::json!({}));
        st.finish_tool_call("tc1", Ok(serde_json::json!({"content": "hi"})), 42);
        let entry = &st.active_tool_calls[0];
        assert_eq!(entry.status, ToolStatus::Ok);
        assert_eq!(entry.elapsed_ms, 42);
        assert!(entry.payload.is_some());
    }

    #[test]
    fn finish_tool_call_error_transitions_status() {
        let mut st = ConversationState::new();
        st.begin_tool_call("tc1".into(), "Bash".into(), serde_json::json!({}));
        st.finish_tool_call("tc1", Err("permission denied".into()), 12);
        let entry = &st.active_tool_calls[0];
        assert_eq!(entry.status, ToolStatus::Error);
        assert_eq!(entry.elapsed_ms, 12);
        match entry.payload.as_ref().expect("error payload") {
            ToolPayload::Preview(s) => assert!(s.contains("permission denied")),
            other => panic!("expected Preview, got {other:?}"),
        }
    }

    #[test]
    fn finish_tool_call_unknown_id_is_silent() {
        let mut st = ConversationState::new();
        // No begin — orphan Finish. Must not panic, must not mutate.
        st.finish_tool_call("bogus", Ok(serde_json::json!({})), 1);
        assert!(st.active_tool_calls.is_empty());
    }

    #[test]
    fn submit_clears_active_tool_calls() {
        let mut st = ConversationState::new();
        st.begin_tool_call("a".into(), "Read".into(), serde_json::json!({}));
        st.begin_tool_call("b".into(), "Glob".into(), serde_json::json!({}));
        assert_eq!(st.active_tool_calls.len(), 2);
        st.input = "next turn".into();
        st.submit().expect("submit");
        assert!(st.active_tool_calls.is_empty());
    }

    #[test]
    fn finish_tool_call_preserves_insertion_order() {
        // Out-of-order Finish must find entries by id, not by position.
        let mut st = ConversationState::new();
        st.begin_tool_call("a".into(), "Read".into(), serde_json::json!({}));
        st.begin_tool_call("b".into(), "Glob".into(), serde_json::json!({}));
        st.finish_tool_call("b", Ok(serde_json::json!({"numFiles": 2})), 10);
        assert_eq!(st.active_tool_calls[0].id, "a");
        assert_eq!(st.active_tool_calls[0].status, ToolStatus::Running);
        assert_eq!(st.active_tool_calls[1].id, "b");
        assert_eq!(st.active_tool_calls[1].status, ToolStatus::Ok);
    }

    // ----- 017 §4 message queue ---------------------------------------

    #[test]
    fn queued_messages_default_empty() {
        let st = ConversationState::new();
        assert!(st.queued_messages.is_empty());
        assert!(!st.has_queued_messages());
    }

    #[test]
    fn push_to_queue_while_streaming_keeps_streaming_true() {
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().expect("first submit fires");
        assert!(st.streaming);
        st.push_to_queue("queued-a".into());
        // Direct push must not flip streaming off; the prior turn
        // owns the streaming lifecycle.
        assert!(st.streaming);
        assert_eq!(st.queued_messages, vec!["queued-a".to_string()]);
    }

    #[test]
    fn submit_during_streaming_pushes_to_queue_not_history() {
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        assert_eq!(st.messages.len(), 1);
        // Second submit during the stream redirects onto the queue.
        st.input = "queued-a".into();
        let ret = st.submit();
        assert!(ret.is_none());
        assert_eq!(st.messages.len(), 1, "queued submits must not land in history");
        assert_eq!(st.queued_messages, vec!["queued-a".to_string()]);
        assert_eq!(st.input, "", "input cleared after queue push");
        assert!(st.streaming, "streaming flag must stay true on queue push");
    }

    #[test]
    fn submit_during_streaming_drops_whitespace_only_input() {
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        st.input = "   \n  ".into();
        assert!(st.submit().is_none());
        assert!(st.queued_messages.is_empty(), "whitespace must not enter queue");
        assert_eq!(st.input, "", "empty input cleared even when not queued");
    }

    #[test]
    fn pop_queue_head_fifo_order() {
        let mut st = ConversationState::new();
        st.push_to_queue("A".into());
        st.push_to_queue("B".into());
        st.push_to_queue("C".into());
        assert_eq!(st.pop_queue_head().as_deref(), Some("A"));
        assert_eq!(st.pop_queue_head().as_deref(), Some("B"));
        assert_eq!(st.pop_queue_head().as_deref(), Some("C"));
        assert_eq!(st.pop_queue_head(), None);
    }

    #[test]
    fn pop_queue_tail_removes_from_queue() {
        let mut st = ConversationState::new();
        st.push_to_queue("A".into());
        st.push_to_queue("B".into());
        assert_eq!(st.pop_queue_tail().as_deref(), Some("B"));
        assert_eq!(st.queued_messages, vec!["A".to_string()]);
        assert_eq!(st.pop_queue_tail().as_deref(), Some("A"));
        assert!(st.queued_messages.is_empty());
        assert_eq!(st.pop_queue_tail(), None);
    }

    #[test]
    fn consume_queue_head_into_input_transitions_state() {
        // Simulates the event loop's post-finish auto-submit arm.
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        st.push_to_queue("queued-a".into());
        st.push_to_queue("queued-b".into());
        st.append_stream_delta("reply-one");
        st.finish_stream();
        assert!(!st.streaming);
        let consumed = st.consume_queue_head_into_input();
        assert!(consumed);
        assert_eq!(st.input, "queued-a");
        assert_eq!(st.queued_messages, vec!["queued-b".to_string()]);
        // Now re-submit to simulate the event loop's next step.
        let hist = st.submit().expect("queued head submits as new turn");
        // History must include first user turn, assistant reply,
        // and the newly-submitted queued-a.
        assert!(st.streaming);
        assert_eq!(hist.last().unwrap().content, "queued-a");
    }

    #[test]
    fn finish_stream_auto_pops_multi_turn_queue_drain() {
        // Verify the event-loop pattern: finish → consume_head →
        // submit → finish → consume_head → submit → drain empty.
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        st.push_to_queue("A".into());
        st.push_to_queue("B".into());
        st.finish_stream();

        assert!(st.consume_queue_head_into_input());
        assert_eq!(st.input, "A");
        st.submit().unwrap();
        st.finish_stream();

        assert!(st.consume_queue_head_into_input());
        assert_eq!(st.input, "B");
        st.submit().unwrap();
        st.finish_stream();

        assert!(!st.consume_queue_head_into_input(), "queue drained");
        assert_eq!(st.input, "");
    }

    #[test]
    fn fail_stream_leaves_queue_for_auto_pop() {
        // Mirror of finish_stream — the event-loop handles both
        // symmetrically (design.md §4.10 resolved to on-both).
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        st.push_to_queue("retry".into());
        st.fail_stream("network".into());
        assert!(!st.streaming);
        assert_eq!(st.queued_messages, vec!["retry".to_string()]);
        assert!(st.consume_queue_head_into_input());
        assert_eq!(st.input, "retry");
    }

    #[test]
    fn up_arrow_restores_last_queued_message() {
        // State-level unit: input empty + queue non-empty → pop
        // tail into input. (The handle_key binding lives in
        // tui::mod; this test exercises the pure method.)
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        st.push_to_queue("early".into());
        st.push_to_queue("most-recent".into());
        // Simulate handle_key's guard + call.
        assert!(st.input.is_empty());
        assert!(st.has_queued_messages());
        let restored = st.pop_queue_tail().unwrap();
        st.input = restored;
        assert_eq!(st.input, "most-recent");
        assert_eq!(st.queued_messages, vec!["early".to_string()]);
    }

    #[test]
    fn consume_queue_head_into_input_noop_on_empty_queue() {
        let mut st = ConversationState::new();
        assert!(!st.consume_queue_head_into_input());
        assert_eq!(st.input, "");
    }

    #[test]
    fn submit_clears_input_on_queue_push_even_with_leading_whitespace() {
        // Idempotent: whether the trimmed input queued or dropped,
        // st.input ends empty so the next keystroke starts fresh.
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        st.input = "   padded   ".into();
        st.submit();
        assert_eq!(st.input, "");
        assert_eq!(
            st.queued_messages,
            vec!["   padded   ".to_string()],
            "padding preserved verbatim — the user typed it intentionally"
        );
    }

    /// Regression: openspec 015 §9 — `consume_pending_notifications`
    /// drains the store, renders XML with tool_use_id extras, and
    /// pushes a synthetic user message that includes the
    /// `<tool-use-id>` reconciliation key.
    #[test]
    fn consume_pending_notifications_pushes_synthetic_user_with_xml() {
        use crate::tasks::{TaskId, TaskRecord, TaskState as TS, TaskStore};
        let store = TaskStore::new();
        let id = TaskId::generate();
        let mut record = TaskRecord::new_agent(
            id.clone(),
            "summarize roadmap".into(),
            "do it".into(),
        );
        record.state = TS::Completed;
        record.is_backgrounded = true;
        record.inject_on_next_turn = true;
        record.tool_use_id = Some("toolu_unit_test".into());
        store.insert(record);

        let mut st = ConversationState::new();
        let count = st.consume_pending_notifications(&store);
        assert_eq!(count, 1);
        assert!(!store.has_pending_notifications(), "drain clears flag");

        let last = st.messages.last().expect("synthetic message present");
        assert!(last.is_synthetic);
        assert_eq!(last.role, OpenAiChatRole::User);
        assert!(last.content.contains("<task-notification>"));
        assert!(last.content.contains(id.as_str()));
        assert!(last.content.contains("<tool-use-id>toolu_unit_test"));
        assert!(last.content.contains("<status>completed</status>"));
    }

    /// Regression: `submit_auto_notification_turn` returns `None` when
    /// the store has no pendings and DOES NOT mutate state (no streaming
    /// flip, no message push). This is the safety net for the
    /// 50ms-tick poll path.
    #[test]
    fn submit_auto_notification_turn_is_noop_when_store_empty() {
        use crate::tasks::TaskStore;
        let store = TaskStore::new();
        let mut st = ConversationState::new();
        let before_messages = st.messages.len();
        let before_streaming = st.streaming;
        let result = st.submit_auto_notification_turn(&store);
        assert!(result.is_none());
        assert_eq!(st.messages.len(), before_messages);
        assert_eq!(st.streaming, before_streaming);
    }

    /// Regression: when pendings exist, `submit_auto_notification_turn`
    /// flips streaming, sets request_started_at, returns history that
    /// includes the synthetic notification user message at the end.
    #[test]
    fn submit_auto_notification_turn_flips_streaming_and_returns_history() {
        use crate::tasks::{TaskId, TaskRecord, TaskState as TS, TaskStore};
        let store = TaskStore::new();
        let id = TaskId::generate();
        let mut record = TaskRecord::new_agent(
            id.clone(),
            "summarize roadmap".into(),
            "do it".into(),
        );
        record.state = TS::Completed;
        record.is_backgrounded = true;
        record.inject_on_next_turn = true;
        record.tool_use_id = Some("toolu_auto".into());
        store.insert(record);

        let mut st = ConversationState::new();
        assert!(!st.streaming);
        let history = st
            .submit_auto_notification_turn(&store)
            .expect("auto turn dispatched");
        assert!(st.streaming, "streaming must flip true");
        assert!(st.request_started_at.is_some());
        assert!(st.turn_verb.is_some(), "turn_verb seeded");
        let last = history.last().expect("history non-empty");
        assert_eq!(last.role, OpenAiChatRole::User);
        assert!(last.content.contains("<task-notification>"));
        assert!(last.content.contains("<tool-use-id>toolu_auto"));
    }

    /// Regression: openspec 015 §9 — the next user turn after a BG
    /// `Agent` dispatch must carry the assistant `tool_use` block so
    /// the model can match the eventual `<task-notification>` to its
    /// own prior call. Confirmed under tmux (2026-04-21) that without
    /// this the model hallucinates and re-spawns. See
    /// `tasks/LocalAgentTask/LocalAgentTask.tsx:247-257`.
    #[test]
    fn history_for_request_reconstructs_tool_use_pair_from_archived_role_tool() {
        use crate::inference::OpenAiChatRole;
        let mut st = ConversationState::new();
        // Turn N: user asked, assistant chose to call Agent BG, the
        // synchronous tool result came back as `status: backgrounded`.
        // The TUI's finish_stream archives that as a Role::Tool entry
        // carrying the JSON-serialized ToolCallArchive.
        st.messages.push(DisplayMessage {
            role: OpenAiChatRole::User,
            content: "spawn an Explore subagent in the background".into(),
            wire_override: None,
            origin: DisplayOrigin::Transcript,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        let archive = tool_render::ToolCallArchive {
            status: tool_render::ToolStatus::Ok,
            name: "Agent".into(),
            elapsed_ms: 12,
            args: serde_json::json!({
                "description": "summarize",
                "subagent_type": "Explore",
                "run_in_background": true,
                "prompt": "summarize roadmap.md",
            }),
            payload: None,
            id: "toolu_test_id_001".into(),
            raw_result: Some(serde_json::json!({
                "status": "backgrounded",
                "task_id": "abc123def",
            })),
        };
        st.messages.push(DisplayMessage {
            role: OpenAiChatRole::Tool,
            content: serde_json::to_string(&archive).unwrap(),
            wire_override: None,
            origin: DisplayOrigin::Transcript,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        st.messages.push(DisplayMessage {
            role: OpenAiChatRole::Assistant,
            content: "Async agent launched successfully.".into(),
            wire_override: None,
            origin: DisplayOrigin::Transcript,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        // Turn N+1: user asks "did it finish?".
        st.messages.push(DisplayMessage {
            role: OpenAiChatRole::User,
            content: "did it finish?".into(),
            wire_override: None,
            origin: DisplayOrigin::Transcript,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_synthetic: false,
        });
        let hist = st.history_for_request();
        // Expect: user(spawn), assistant(tool_use), tool(result),
        // assistant("launched..."), user(did it finish).
        assert_eq!(
            hist.len(),
            5,
            "5 messages in expanded history; got {}: {hist:#?}",
            hist.len()
        );
        assert_eq!(hist[0].role, OpenAiChatRole::User);
        assert_eq!(hist[0].content, "spawn an Explore subagent in the background");
        assert_eq!(hist[1].role, OpenAiChatRole::Assistant);
        assert_eq!(hist[1].tool_calls.len(), 1, "tool_use preserved");
        assert_eq!(hist[1].tool_calls[0].id, "toolu_test_id_001");
        assert_eq!(hist[1].tool_calls[0].function.name, "Agent");
        assert!(
            hist[1].tool_calls[0].function.arguments.contains("Explore"),
            "tool_use arguments preserved"
        );
        assert_eq!(hist[2].role, OpenAiChatRole::Tool);
        assert_eq!(
            hist[2].tool_call_id.as_deref(),
            Some("toolu_test_id_001"),
            "tool_result paired by id"
        );
        assert!(
            hist[2].content.contains("backgrounded"),
            "raw_result body preserved"
        );
        assert_eq!(hist[3].role, OpenAiChatRole::Assistant);
        assert_eq!(hist[3].content, "Async agent launched successfully.");
        assert_eq!(hist[4].role, OpenAiChatRole::User);
        assert_eq!(hist[4].content, "did it finish?");
    }
}
