

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

    /// Upstream-shape agentId (`a<16-hex>`) generated via
    /// `tasks::id::create_agent_id` at spawn time. Separate from `id`
    /// (the internal TaskStore key) and `tool_use_id` (the Anthropic
    /// wire-level identifier used for tool_result pairing). This is the
    /// identifier the user sees in "Async agent launched successfully."
    /// and the basis for `getTaskOutputPath` on disk.
    pub agent_id: Option<String>,

    pub rendered_completion_line: bool,

    pub subagent_type: Option<String>,

    pub description: Option<String>,

    pub tokens: u64,
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
    fn state_terminality_is_exclusive_with_active() {
        for s in [
            TaskState::Pending,
            TaskState::Running,
            TaskState::Backgrounded,
            TaskState::Completed,
            TaskState::Failed,
            TaskState::Stopped,
        ] {
            assert_ne!(
                s.is_terminal(),
                s.is_active(),
                "state {s:?} is both terminal and active"
            );
        }
    }

    #[test]
    fn running_and_backgrounded_both_count_active() {
        assert!(TaskState::Running.is_active());
        assert!(TaskState::Backgrounded.is_active());
        assert!(TaskState::Pending.is_active());
    }

    #[test]
    fn completed_failed_stopped_are_terminal() {
        assert!(TaskState::Completed.is_terminal());
        assert!(TaskState::Failed.is_terminal());
        assert!(TaskState::Stopped.is_terminal());
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
