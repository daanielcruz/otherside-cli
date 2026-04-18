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

use std::time::Instant;

use crate::inference::{OpenAiChatMessage, OpenAiChatRole};

use super::autocomplete::Autocomplete;

/// A finalized message in the chat log.
///
/// `role` is one of `User` / `Assistant` / `System` — we reuse the canonical
/// OpenAI role enum so building an [`OpenAiChatMessage`] for the next
/// request is a field-for-field copy, no translation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayMessage {
    pub role: OpenAiChatRole,
    pub content: String,
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

    /// Running output-token count for the in-flight response. Reset on
    /// each submit. Bumped from SSE usage events (once wired).
    pub output_tokens: u64,

    /// Input tokens consumed so far this session. Maps to the
    /// context-window arithmetic on the statusline.
    pub input_tokens: u64,

    /// Effective context window size for the current model (default
    /// 200 000 tokens — upstream's Opus 4 baseline).
    pub context_window: u64,

    /// Cumulative thinking-block duration for the in-flight response,
    /// in ms. Reset on each submit.
    pub thought_ms: u64,

    /// Tip index for the rotating tip line. Bumped on every submit so
    /// long sessions see a wider set of tips.
    pub tip_rotation_index: usize,

    /// Active slash-autocomplete popup, if any.
    pub autocomplete: Option<Autocomplete>,

    /// Current permission mode. Shift+Tab cycles through the four
    /// values. `--yolo` / `permissionMode` in settings set the initial
    /// value; mutation via the info row does NOT persist to
    /// `settings.json` (C40 parity — session-scoped toggle).
    pub permission_mode: crate::config::PermissionMode,

    /// Model id the user is currently talking to. Kept on state so
    /// `/model <id>` can swap it mid-session without rebuilding the
    /// TUI. The statusline reads this; request builders clone it.
    pub model: String,
}

impl ConversationState {
    /// Fresh state with no messages, empty input, scroll pinned to bottom.
    pub fn new() -> Self {
        Self {
            context_window: 200_000,
            ..Self::default()
        }
    }

    /// Fresh state sized to the model's context window — 1M when the
    /// raw model alias carries a `[1m]` suffix, 200K otherwise. Mirrors
    /// upstream `getContextWindowForModel` (see memory entry on 1M
    /// mechanics). The `permission_mode` argument seeds the session
    /// mode so `--yolo` (or a policy-set mode) is respected on launch.
    pub fn new_for_model(raw_model: &str) -> Self {
        Self::new_for_model_with_mode(raw_model, crate::config::PermissionMode::Default)
    }

    pub fn new_for_model_with_mode(
        raw_model: &str,
        mode: crate::config::PermissionMode,
    ) -> Self {
        let has_1m = raw_model.to_ascii_lowercase().contains("[1m]");
        Self {
            context_window: if has_1m { 1_000_000 } else { 200_000 },
            permission_mode: mode,
            model: raw_model.to_string(),
            ..Self::default()
        }
    }

    /// Percentage of the context window currently consumed, rounded
    /// to the nearest integer. Uses `input_tokens` as the usage
    /// signal — matches upstream's "context remaining" math.
    pub fn context_used_percent(&self) -> u32 {
        if self.context_window == 0 {
            return 0;
        }
        let pct = (self.input_tokens.saturating_mul(100)) / self.context_window;
        pct.min(100) as u32
    }

    /// Tokens remaining in the context window.
    pub fn context_available(&self) -> u64 {
        self.context_window.saturating_sub(self.input_tokens)
    }

    /// Render the context-window total in the statusline format users
    /// expect: `200K`, `1M`. Upstream's model-display string appends
    /// ` (1M context)` for the 1M variant; we surface the same signal
    /// compactly.
    pub fn context_window_label(&self) -> String {
        match self.context_window {
            n if n >= 1_000_000 => format!("{}M", n / 1_000_000),
            n => format!("{}K", n / 1_000),
        }
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
    }

    /// Scroll down one line toward the newest message. Saturates at zero
    /// which pins the log to the bottom.
    pub fn scroll_down(&mut self, lines: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(lines);
    }

    /// Pin the log to the newest message. Called after submit and after
    /// every incoming stream delta so newly-arrived text is always visible.
    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
    }

    /// Attempt to submit the current input as a new user turn.
    ///
    /// Returns `Some(history)` — the full message list that should be sent
    /// to the provider — when the submission was accepted. Returns `None`
    /// when the input was empty or a stream is already in flight; the
    /// caller should ignore the keypress in that case.
    ///
    /// Side effects on success:
    ///   - Pushes the user's [`DisplayMessage`] onto `messages`.
    ///   - Clears `input`, flips `streaming = true`, clears the assistant
    ///     buffer, drops any previous error, scrolls to bottom.
    pub fn submit(&mut self) -> Option<Vec<OpenAiChatMessage>> {
        if self.streaming {
            return None;
        }
        let trimmed = self.input.trim();
        if trimmed.is_empty() {
            return None;
        }
        let content = self.input.clone();
        self.messages.push(DisplayMessage {
            role: OpenAiChatRole::User,
            content,
        });
        self.input.clear();
        self.streaming = true;
        self.current_assistant_buffer.clear();
        self.last_error = None;
        self.request_started_at = Some(Instant::now());
        self.output_tokens = 0;
        self.thought_ms = 0;
        self.tip_rotation_index = self.tip_rotation_index.wrapping_add(1);
        self.autocomplete = None;
        self.scroll_to_bottom();
        Some(self.history_for_request())
    }

    /// Recompute the autocomplete popup from the current input. Call
    /// after any input-buffer mutation so the popup opens/closes as
    /// the partial after `/` changes.
    pub fn refresh_autocomplete(&mut self) {
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
    }

    /// Surface an inline system note in the streaming area. Used by
    /// local slashes like `/help` and the NotYetWired stubs.
    pub fn push_system_note(&mut self, text: impl Into<String>) {
        self.messages.push(DisplayMessage {
            role: OpenAiChatRole::System,
            content: text.into(),
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
        let has_1m = new_raw.to_ascii_lowercase().contains("[1m]");
        self.model = new_raw.to_string();
        self.context_window = if has_1m { 1_000_000 } else { 200_000 };
    }

    /// `/compact` — drop finalized messages and surface a short
    /// placeholder so the user sees the session continued. Does NOT
    /// wipe input or autocomplete state (user may be mid-slash).
    pub fn compact_history(&mut self) {
        let kept_count = self.messages.len();
        self.messages.clear();
        self.current_assistant_buffer.clear();
        self.input.clear();
        self.autocomplete = None;
        self.scroll_offset = 0;
        // Synthetic context marker so the transcript isn't mysteriously
        // empty — matches upstream's "Conversation compacted" affordance.
        self.messages.push(DisplayMessage {
            role: OpenAiChatRole::System,
            content: format!(
                "context compacted — {kept_count} prior message{} dropped",
                if kept_count == 1 { "" } else { "s" }
            ),
        });
        self.scroll_to_bottom();
    }

    /// Elapsed wall clock since the current request started, or 0 when
    /// idle. Convenience for the progress line render path.
    pub fn elapsed_ms(&self) -> u64 {
        match self.request_started_at {
            Some(t) => t.elapsed().as_millis() as u64,
            None => 0,
        }
    }

    /// Permission-mode label for the info row. Returns `(glyph, text)`
    /// mirroring upstream's two-chevron indicator. The text includes
    /// the mode name + the "shift+tab to cycle" affordance when the
    /// user can freely switch; yolo mode gets its own copy per C40.
    pub fn permission_mode_label(&self) -> (&'static str, String) {
        match self.permission_mode {
            crate::config::PermissionMode::Default => (
                "⏵⏵",
                "default mode  (shift+tab to cycle)".to_string(),
            ),
            crate::config::PermissionMode::AcceptEdits => (
                "⏵⏵",
                "accept edits mode  (shift+tab to cycle)".to_string(),
            ),
            crate::config::PermissionMode::Plan => (
                "⏵⏵",
                "plan mode  (shift+tab to cycle)".to_string(),
            ),
            crate::config::PermissionMode::Yolo => (
                "⏵⏵",
                "yolo mode enabled  (shift+tab to cycle)".to_string(),
            ),
        }
    }

    /// Advance the permission mode to the next one in the cycle.
    /// Order: Default → Plan → Yolo → Default. AcceptEdits is
    /// deliberately skipped from the Shift+Tab rotation — user
    /// directive 2026-04-18: three-mode cycle is the otherside default.
    /// AcceptEdits remains settable via `settings.json` for users who
    /// want it, just not reachable via the bottom-row affordance.
    pub fn cycle_permission_mode(&mut self) {
        use crate::config::PermissionMode as P;
        self.permission_mode = match self.permission_mode {
            P::Default => P::Plan,
            P::Plan => P::Yolo,
            P::Yolo | P::AcceptEdits => P::Default,
        };
    }

    /// Snapshot `messages` as a `Vec<OpenAiChatMessage>` suitable for the
    /// canonical request. Kept separate from [`submit`](Self::submit) so
    /// tests and future slash commands can peek without side-effects.
    pub fn history_for_request(&self) -> Vec<OpenAiChatMessage> {
        self.messages
            .iter()
            .map(|m| OpenAiChatMessage {
                role: m.role,
                content: m.content.clone(),
                name: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
            })
            .collect()
    }

    /// Append a chunk's content delta onto the in-flight assistant buffer.
    /// Called from the event loop on every [`crate::inference::OpenAiChunk`]
    /// whose `delta.content` is non-empty. Auto-follows the latest output
    /// ONLY when the user hasn't scrolled back — otherwise respect their
    /// viewport so reading history during streaming survives deltas.
    pub fn append_stream_delta(&mut self, delta: &str) {
        self.current_assistant_buffer.push_str(delta);
        if self.scroll_offset == 0 {
            self.scroll_to_bottom();
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
        if !self.current_assistant_buffer.is_empty() {
            let content = std::mem::take(&mut self.current_assistant_buffer);
            self.messages.push(DisplayMessage {
                role: OpenAiChatRole::Assistant,
                content,
            });
        } else {
            self.current_assistant_buffer.clear();
        }
        self.streaming = false;
        self.request_started_at = None;
        self.scroll_to_bottom();
    }

    /// Record an error reported by the provider.
    ///
    /// Any partial assistant text already accumulated is promoted into a
    /// permanent message so the user can see what landed before the
    /// failure; the error text itself is stored in `last_error` for the
    /// render layer to show inline. `streaming` flips back to false so the
    /// input box accepts keys again.
    pub fn fail_stream(&mut self, err: String) {
        if !self.current_assistant_buffer.is_empty() {
            let content = std::mem::take(&mut self.current_assistant_buffer);
            self.messages.push(DisplayMessage {
                role: OpenAiChatRole::Assistant,
                content,
            });
        }
        self.last_error = Some(err);
        self.streaming = false;
        self.request_started_at = None;
        self.scroll_to_bottom();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_for_model_picks_1m_when_suffix_present() {
        let st = ConversationState::new_for_model("claude-opus-4-7[1m]");
        assert_eq!(st.context_window, 1_000_000);
        assert_eq!(st.context_window_label(), "1M");
    }

    #[test]
    fn new_for_model_defaults_to_200k() {
        let st = ConversationState::new_for_model("claude-opus-4-7");
        assert_eq!(st.context_window, 200_000);
        assert_eq!(st.context_window_label(), "200K");
    }

    #[test]
    fn new_for_model_is_case_insensitive() {
        let st = ConversationState::new_for_model("OPUS[1M]");
        assert_eq!(st.context_window, 1_000_000);
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
}
