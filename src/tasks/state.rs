
use std::collections::VecDeque;
use std::time::Instant;

use super::id::TaskId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Pending,
    Running,
    Backgrounded,
    Completed,
    Failed,
    Stopped,
}

impl TaskState {

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Stopped)
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::Backgrounded)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskKind {
    Shell,
    Agent,

    Generic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskDisplayMode {
    Panel,
    InlineAnchor,
}

impl Default for TaskDisplayMode {
    fn default() -> Self {
        Self::Panel
    }
}

#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: TaskId,

    pub name: String,

    pub command: String,
    pub kind: TaskKind,

    pub is_backgrounded: bool,
    pub state: TaskState,
    pub started_at: Instant,

    pub output: VecDeque<String>,

    pub inject_on_next_turn: bool,

    pub exit_code: Option<i32>,

    pub tool_use_id: Option<String>,

    pub agent_id: Option<String>,

    pub rendered_completion_line: bool,

    pub subagent_type: Option<String>,

    pub description: Option<String>,

    pub tokens: u64,

    pub tool_uses: u64,

    pub duration_ms: u64,

    pub error: Option<String>,

    pub display_mode: TaskDisplayMode,

    pub anchor_id: Option<String>,
}

impl TaskRecord {

    pub const OUTPUT_CAPACITY: usize = 200;

    pub fn new_shell(id: TaskId, name: String, command: String) -> Self {
        Self {
            id,
            name,
            command,
            kind: TaskKind::Shell,
            is_backgrounded: false,
            state: TaskState::Running,
            started_at: Instant::now(),
            output: VecDeque::with_capacity(Self::OUTPUT_CAPACITY),
            inject_on_next_turn: false,
            exit_code: None,
            tool_use_id: None,
            agent_id: None,
            rendered_completion_line: false,
            subagent_type: None,
            description: None,
            tokens: 0,
            tool_uses: 0,
            duration_ms: 0,
            error: None,
            display_mode: TaskDisplayMode::Panel,
            anchor_id: None,
        }
    }

    pub fn new_agent(id: TaskId, name: String, prompt: String) -> Self {
        Self {
            id,
            name,
            command: prompt,
            kind: TaskKind::Agent,
            is_backgrounded: false,
            state: TaskState::Running,
            started_at: Instant::now(),
            output: VecDeque::with_capacity(Self::OUTPUT_CAPACITY),
            inject_on_next_turn: false,
            exit_code: None,
            tool_use_id: None,
            agent_id: None,
            rendered_completion_line: false,
            subagent_type: None,
            description: None,
            tokens: 0,
            tool_uses: 0,
            duration_ms: 0,
            error: None,
            display_mode: TaskDisplayMode::Panel,
            anchor_id: None,
        }
    }

    pub fn push_output(&mut self, line: String) {
        if self.output.len() >= Self::OUTPUT_CAPACITY {
            self.output.pop_front();
        }
        self.output.push_back(line);
    }

    pub fn runtime_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_activity_matrix_matches_upstream() {
        let cases: &[(TaskState, bool, bool)] = &[
            (TaskState::Pending, true, false),
            (TaskState::Running, true, false),
            (TaskState::Backgrounded, true, false),
            (TaskState::Completed, false, true),
            (TaskState::Failed, false, true),
            (TaskState::Stopped, false, true),
        ];
        for (s, active, terminal) in cases {
            assert_eq!(s.is_active(), *active, "is_active({s:?})");
            assert_eq!(s.is_terminal(), *terminal, "is_terminal({s:?})");
        }
    }

    #[test]
    fn push_output_evicts_at_capacity() {
        let mut r = TaskRecord::new_shell(
            TaskId::generate(),
            "t".into(),
            "echo hi".into(),
        );
        for i in 0..(TaskRecord::OUTPUT_CAPACITY + 50) {
            r.push_output(format!("line {i}"));
        }
        assert_eq!(r.output.len(), TaskRecord::OUTPUT_CAPACITY);

        assert_eq!(r.output.front().map(String::as_str), Some("line 50"));
    }
}
