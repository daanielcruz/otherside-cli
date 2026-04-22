

use std::time::Instant;

use serde_json::Value;

use crate::inference::{OpenAiChatMessage, OpenAiChatRole};

use super::autocomplete::Autocomplete;
use super::tool_render::{self, ToolStatus};
#[cfg(test)]
use super::tool_render::ToolPayload;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayOrigin {

    Transcript,

    Chrome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayMessage {
    pub role: OpenAiChatRole,
    pub content: String,

    pub wire_override: Option<String>,

    pub origin: DisplayOrigin,

    #[allow(dead_code)]
    pub tool_calls: Vec<crate::inference::OpenAiToolCall>,

    #[allow(dead_code)]
    pub tool_call_id: Option<String>,

    pub is_synthetic: bool,
}

mod tool_call_entry;
pub use tool_call_entry::{format_tool_history_entry, ToolCallEntry};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipColor {

    PlanMode,

    AutoAccept,

    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionChip {
    pub symbol: &'static str,
    pub text: String,
    pub color: ChipColor,
}

#[derive(Debug, Default)]
pub struct ConversationState {

    pub messages: Vec<DisplayMessage>,

    pub input: String,

    pub pending_wire_override: Option<String>,

    pub show_post_clear_splash: bool,

    pub scroll_offset: usize,

    pub streaming: bool,

    pub current_assistant_buffer: String,

    pub last_error: Option<String>,

    pub request_started_at: Option<Instant>,

    pub output_tokens: u64,

    pub cumulative_output_tokens: u64,

    pub input_tokens: u64,

    pub session: crate::state::Session,

    pub thought_ms: u64,

    pub tip_rotation_index: usize,

    pub autocomplete: Option<Autocomplete>,

    pub sticky_bottom: bool,

    pub turn_verb: Option<&'static str>,

    #[allow(clippy::type_complexity)]
    pub turn_task: Option<tokio::task::JoinHandle<()>>,

    pub exit_armed_at: Option<Instant>,

    pub exit_armed_key: Option<&'static str>,

    pub active_tool_calls: Vec<ToolCallEntry>,

    pub queued_messages: Vec<String>,

    pub persistence: crate::state::PersistenceState,

    pub render_verbose: bool,

    pub active_menu: Option<super::menu::OverlayMenu>,

    pub pending_permission: Option<super::menu::PendingPermissionPrompt>,

    pub pending_question: Option<super::menu::PendingQuestion>,

    pub session_allowlist: crate::permissions::RuntimePermissionGrants,

    pub session_writer: Option<crate::sessions::transcript::Writer>,

    pub session_id: Option<crate::sessions::SessionId>,

    pub tasks: crate::tasks::TaskStore,

    pub toggle_feedback: Option<(String, Instant)>,
}

impl ConversationState {

    pub fn append_record(&mut self, record: crate::sessions::Record) {
        if let Some(w) = self.session_writer.as_mut() {
            if let Err(e) = w.append(&record) {
                tracing::warn!(?e, "failed to append session record");
            }
        }
    }

    pub fn set_feedback(&mut self, msg: impl Into<String>) {
        self.toggle_feedback = Some((msg.into(), Instant::now()));
    }

    pub fn prune_feedback(&mut self) {
        if let Some((_, stamped)) = &self.toggle_feedback {
            if stamped.elapsed() >= FEEDBACK_TTL {
                self.toggle_feedback = None;
            }
        }
    }
}

fn backgroundable_kind(tool_name: &str) -> Option<crate::tasks::TaskKind> {
    match tool_name {
        "Agent" => Some(crate::tasks::TaskKind::Agent),
        "Bash" => Some(crate::tasks::TaskKind::Shell),
        _ => None,
    }
}

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

        let mut st = ConversationState::default();

        st.push_anchor("config", "", "Status dialog dismissed", DisplayOrigin::Chrome);

        st.input = "what does main.rs do?".into();
        let _ = st.submit();

        assert_eq!(st.messages.len(), 3);

        let hist = st.history_for_request();
        assert_eq!(hist.len(), 1, "chrome anchors must not ride the wire");
        assert_eq!(hist[0].content, "what does main.rs do?");
    }

    #[test]
    fn history_for_request_includes_transcript_anchors() {

        let mut st = ConversationState::default();
        st.push_anchor("compact", "", "42 msgs dropped", DisplayOrigin::Transcript);
        let hist = st.history_for_request();
        assert_eq!(hist.len(), 2, "anchor pair rides the wire");
        assert_eq!(hist[0].content, "/compact");
        assert!(hist[1].content.starts_with("⎿ "));
    }

    #[test]
    fn push_system_note_is_chrome() {

        let mut st = ConversationState::default();
        st.push_system_note("login needs stdin interaction");
        assert_eq!(st.messages.len(), 1);
        assert_eq!(st.messages[0].origin, DisplayOrigin::Chrome);
        assert!(st.history_for_request().is_empty(), "system notes stay local");
    }

    #[test]
    fn pending_wire_override_rides_history_but_not_display() {

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

pub const EXIT_DOUBLE_PRESS_MS: u64 = 800;

impl ConversationState {

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

    pub fn context_used_percent(&self) -> u32 {
        self.session.context_used_percent(self.input_tokens)
    }

    pub fn context_available(&self) -> u64 {
        self.session.context_available(self.input_tokens)
    }

    pub fn context_window_label(&self) -> String {
        self.session.context_window_label()
    }

    pub fn input_push_char(&mut self, c: char) {
        self.input.push(c);
    }

    pub fn input_push_newline(&mut self) {
        self.input.push('\n');
    }

    pub fn input_backspace(&mut self) {
        self.input.pop();
    }

    pub fn input_clear(&mut self) {
        self.input.clear();
    }

    pub fn scroll_up(&mut self, lines: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(lines);
        self.sticky_bottom = false;
    }

    pub fn scroll_down(&mut self, lines: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(lines);
        if self.scroll_offset == 0 {
            self.sticky_bottom = true;
        }
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
        self.sticky_bottom = true;
    }

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

        self.active_tool_calls.clear();
        Some(self.history_for_request())
    }

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

                if r.is_backgrounded {
                    r.inject_on_next_turn = true;
                }
            });
        }
    }

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

    pub fn refresh_autocomplete(&mut self) {
        if self.streaming {
            self.autocomplete = None;
            return;
        }
        self.autocomplete = Autocomplete::from_input(&self.input);
    }

    pub fn close_autocomplete(&mut self) {
        self.autocomplete = None;
    }

    pub fn clear_conversation(&mut self) {
        self.messages.clear();
        self.current_assistant_buffer.clear();
        self.last_error = None;
        self.input.clear();
        self.autocomplete = None;
        self.scroll_offset = 0;

        self.input_tokens = 0;
        self.output_tokens = 0;
        self.cumulative_output_tokens = 0;
        self.thought_ms = 0;

        self.show_post_clear_splash = true;
    }

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

    pub fn switch_model(&mut self, new_raw: &str) {
        self.session.set_model(new_raw);
    }

    pub fn compact_history(&mut self) {
        self.messages.clear();
        self.current_assistant_buffer.clear();
        self.input.clear();
        self.autocomplete = None;
        self.scroll_offset = 0;

    }

    pub fn elapsed_ms(&self) -> u64 {
        match self.request_started_at {
            Some(t) => t.elapsed().as_millis() as u64,
            None => 0,
        }
    }

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

    pub fn cycle_permission_mode(&mut self) {
        self.session.cycle_permission_mode();
    }

    pub fn submit_auto_notification_turn(
        &mut self,
        store: &crate::tasks::TaskStore,
    ) -> Option<Vec<OpenAiChatMessage>> {
        let count = self.consume_pending_notifications(store);
        if count == 0 {
            return None;
        }

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

    pub fn history_for_request(&self) -> Vec<OpenAiChatMessage> {
        let mut out: Vec<OpenAiChatMessage> = Vec::with_capacity(self.messages.len());
        for m in &self.messages {
            if m.origin != DisplayOrigin::Transcript {
                continue;
            }
            if m.role == OpenAiChatRole::Tool {

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

    pub fn update_usage(&mut self, input_tokens: Option<u64>, output_tokens: Option<u64>) {
        if let Some(v) = input_tokens {

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

    pub fn total_output_tokens(&self) -> u64 {
        self.cumulative_output_tokens
            .saturating_add(self.output_tokens)
    }

    pub fn append_stream_delta(&mut self, delta: &str) {

        if self.thought_ms == 0 {
            if let Some(started) = self.request_started_at {
                let elapsed = started.elapsed().as_millis() as u64;
                if elapsed > 0 {
                    self.thought_ms = elapsed;
                }
            }
        }
        self.current_assistant_buffer.push_str(delta);

        if self.sticky_bottom {
            self.scroll_offset = 0;
        }
    }

    pub fn flush_assistant_buffer(&mut self) {
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
    }

    pub fn finish_stream(&mut self) {

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

    }

    pub fn fail_stream(&mut self, err: String) {

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

    }

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
        self.push_system_note("⎿  Interrupted · What should Claude do instead?");
        true
    }

    pub fn arm_exit_confirmation(&mut self, key_label: &'static str) {
        self.exit_armed_at = Some(Instant::now());
        self.exit_armed_key = Some(key_label);
    }

    pub fn exit_confirmed(&self) -> bool {
        self.exit_armed_at
            .map(|t| t.elapsed().as_millis() < EXIT_DOUBLE_PRESS_MS as u128)
            .unwrap_or(false)
    }

    pub fn clear_exit_armed(&mut self) {
        self.exit_armed_at = None;
        self.exit_armed_key = None;
    }

    pub fn clear_input(&mut self) {
        self.input.clear();
        self.autocomplete = None;
    }

    pub fn push_to_queue(&mut self, msg: String) {
        self.queued_messages.push(msg);
    }

    pub fn pop_queue_head(&mut self) -> Option<String> {
        if self.queued_messages.is_empty() {
            None
        } else {
            Some(self.queued_messages.remove(0))
        }
    }

    pub fn pop_queue_tail(&mut self) -> Option<String> {
        self.queued_messages.pop()
    }

    pub fn has_queued_messages(&self) -> bool {
        !self.queued_messages.is_empty()
    }

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

        let mut st = ConversationState::new();
        assert!(st.submit().is_none());
        assert_eq!(st.messages.len(), 0);
        assert!(!st.streaming);
    }

    #[test]
    fn whitespace_only_input_is_not_submittable() {

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

        let mut st = ConversationState::new();
        st.input_push_char('a');
        st.input_push_newline();
        st.input_push_char('b');
        assert_eq!(st.input, "a\nb");
    }

    #[test]
    fn autocomplete_refresh_is_no_op_while_streaming() {

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

        let mut st = ConversationState::new();
        st.input = "hi".to_string();
        st.submit().unwrap();
        st.append_stream_delta("hello");
        assert_eq!(st.current_assistant_buffer, "hello");
        assert!(st.streaming);
    }

    #[test]
    fn scroll_up_sticks_through_deltas() {

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

        let mut st = ConversationState::new();
        assert_eq!(st.output_tokens, 0);
        st.update_usage(Some(1234), None);
        assert_eq!(st.input_tokens, 1234);
        assert_eq!(st.output_tokens, 0);
        assert_eq!(st.cumulative_output_tokens, 0);
    }

    #[test]
    fn update_usage_input_update_archives_prior_output() {

        let mut st = ConversationState::new();
        st.update_usage(Some(1000), None);
        st.update_usage(None, Some(42));
        st.update_usage(Some(1200), None);
        assert_eq!(st.input_tokens, 1200);
        assert_eq!(st.output_tokens, 0, "output resets on boundary");
        assert_eq!(st.cumulative_output_tokens, 42, "prior output archived");
    }

    #[test]
    fn update_usage_replaces_output_within_message() {

        let mut st = ConversationState::new();
        st.input_tokens = 555;
        st.update_usage(None, Some(77));
        assert_eq!(st.output_tokens, 77);
        assert_eq!(st.cumulative_output_tokens, 0);

        st.update_usage(None, Some(140));
        assert_eq!(st.output_tokens, 140);
        assert_eq!(st.cumulative_output_tokens, 0);
        assert_eq!(st.input_tokens, 555, "input side must be untouched");
    }

    #[test]
    fn update_usage_folds_prior_output_on_new_message_start() {

        let mut st = ConversationState::new();

        st.update_usage(Some(10_000), None);
        st.update_usage(None, Some(200));
        assert_eq!(st.output_tokens, 200);
        assert_eq!(st.cumulative_output_tokens, 0);

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
        st.update_usage(None, Some(540));
        assert_eq!(st.output_tokens, 540);
        assert_eq!(st.cumulative_output_tokens, 200);
        assert_eq!(st.total_output_tokens(), 740, "turn-wide output preserved");
    }

    #[test]
    fn update_usage_total_preserves_output_across_tool_chain() {

        let mut st = ConversationState::new();

        st.update_usage(Some(20_000), None);
        st.update_usage(None, Some(50));

        st.update_usage(Some(21_000), None);
        st.update_usage(None, Some(120));

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

        let mut st = ConversationState::new();
        st.input = "ask".to_string();
        st.submit().unwrap();
        let v0 = st.turn_verb;
        for _ in 0..100 {
            st.append_stream_delta("x");
        }
        assert_eq!(st.turn_verb, v0);
    }

    #[test]
    fn cycle_permission_mode_three_visible_stops() {

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

        assert_eq!(chip.text, "yolo on");
        assert_eq!(chip.color, ChipColor::Error);
    }

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

        let mut st = ConversationState::new();
        st.begin_tool_call("a".into(), "Read".into(), serde_json::json!({}));
        st.begin_tool_call("b".into(), "Glob".into(), serde_json::json!({}));
        st.finish_tool_call("b", Ok(serde_json::json!({"numFiles": 2})), 10);
        assert_eq!(st.active_tool_calls[0].id, "a");
        assert_eq!(st.active_tool_calls[0].status, ToolStatus::Running);
        assert_eq!(st.active_tool_calls[1].id, "b");
        assert_eq!(st.active_tool_calls[1].status, ToolStatus::Ok);
    }

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

        assert!(st.streaming);
        assert_eq!(st.queued_messages, vec!["queued-a".to_string()]);
    }

    #[test]
    fn submit_during_streaming_pushes_to_queue_not_history() {
        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        assert_eq!(st.messages.len(), 1);

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

        let hist = st.submit().expect("queued head submits as new turn");

        assert!(st.streaming);
        assert_eq!(hist.last().unwrap().content, "queued-a");
    }

    #[test]
    fn cancel_stream_emits_upstream_interrupt_trailer() {
        let mut st = ConversationState::new();
        st.input = "long prompt".into();
        st.submit().unwrap();
        st.append_stream_delta("partial reply");

        let cancelled = st.cancel_stream();
        assert!(cancelled);

        let last = st.messages.last().unwrap();
        assert_eq!(last.role, OpenAiChatRole::System);
        assert_eq!(
            last.content, "⎿  Interrupted · What should Claude do instead?",
            "upstream hardcodes this hint at components/InterruptedByUser.tsx:8 + InterruptedHint.tsx:8"
        );
        assert!(!st.streaming);
    }

    #[test]
    fn flush_assistant_buffer_drains_to_messages_between_turns() {
        let mut st = ConversationState::new();
        st.input = "go".into();
        st.submit().unwrap();
        st.append_stream_delta("Looking at files");

        st.flush_assistant_buffer();

        assert!(st.current_assistant_buffer.is_empty());
        let last = st.messages.last().unwrap();
        assert_eq!(last.role, OpenAiChatRole::Assistant);
        assert_eq!(last.content, "Looking at files");
        assert!(
            st.streaming,
            "flush must not end the stream — streaming still active for turn N+1"
        );

        st.append_stream_delta("main.rs contains X");
        assert_eq!(st.current_assistant_buffer, "main.rs contains X");
        st.finish_stream();

        let assistants: Vec<&str> = st
            .messages
            .iter()
            .filter(|m| m.role == OpenAiChatRole::Assistant)
            .map(|m| m.content.as_str())
            .collect();
        assert_eq!(
            assistants,
            vec!["Looking at files", "main.rs contains X"],
            "each assistant segment lands as its own message, no cross-turn mash"
        );
    }

    #[test]
    fn flush_assistant_buffer_is_noop_when_empty() {
        let mut st = ConversationState::new();
        let before_len = st.messages.len();
        st.flush_assistant_buffer();
        assert_eq!(st.messages.len(), before_len);
    }

    #[test]
    fn finish_stream_auto_pops_multi_turn_queue_drain() {

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

        let mut st = ConversationState::new();
        st.input = "first".into();
        st.submit().unwrap();
        st.push_to_queue("early".into());
        st.push_to_queue("most-recent".into());

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

    #[test]
    fn history_for_request_reconstructs_tool_use_pair_from_archived_role_tool() {
        use crate::inference::OpenAiChatRole;
        let mut st = ConversationState::new();

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
