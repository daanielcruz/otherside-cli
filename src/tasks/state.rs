//! Task state types — the enum + record shape consumed by the
//! store, runner, pill, and dialog.

use std::collections::VecDeque;
use std::time::Instant;

use super::id::TaskId;

/// Lifecycle state of a single task. Transition matrix:
///
/// ```text
///   Pending ──▶ Running ──▶ Completed
///                  │   ╲
///                  │    ╲─▶ Failed
///                  │    ╲─▶ Stopped   (user `x` / TaskStop)
///                  ▼
///              Backgrounded ──▶ Completed / Failed / Stopped
///                  ▲
///                  └── Running can re-enter on foreground via dialog
/// ```
///
/// `Backgrounded` is the fork: `Running`'s UI line flips from
/// `⎿ Running…` to `⎿ Running in the background (↓ to manage)`.
/// Completion surfacing (XML injection on next turn) only fires on
/// a transition INTO a terminal state from `Backgrounded`.
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
    /// True for terminal states — task is done, no further work.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Stopped)
    }

    /// True for states that count toward the footer pill and the
    /// "any running task" hotkey predicate.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::Backgrounded)
    }
}

/// Classification driving pill label form and dialog title. Upstream
/// splits tasks into three user-facing buckets:
/// `tasks/pillLabel.ts:10-67` — "N shells", "N local agents",
/// "N background tasks" (mixed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskKind {
    Shell,
    Agent,
    /// Catch-all for future tool-sourced tasks. Pill labels them as
    /// "background tasks" (the mixed/aggregate form).
    Generic,
}

/// One backgroundable unit of work.
#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: TaskId,
    /// Short human label. For Shell = a 3-5 word summary of the
    /// command (upstream calls this `summary` — see
    /// `LocalShellTask.tsx:248`). For Agent = the subagent name.
    pub name: String,
    /// The literal command / prompt. Shown in detail view under
    /// `Command:`.
    pub command: String,
    pub kind: TaskKind,
    /// True once Ctrl+B flipped it from Running → Backgrounded, or
    /// a task was spawned directly into background.
    pub is_backgrounded: bool,
    pub state: TaskState,
    pub started_at: Instant,
    /// Ring buffer of the task's stdout/stderr/output lines.
    /// Bounded — a runaway task shouldn't OOM the store. Detail
    /// view walks this for the `Output:` panel.
    pub output: VecDeque<String>,
    /// Wire-layer flag: when `true`, the next user-turn assembly
    /// pipeline emits a `<task-notification>` block for this
    /// record. Flipped true on terminal-state transition while
    /// backgrounded; flipped false after inject.
    pub inject_on_next_turn: bool,
    /// Populated on terminal-state transition. Rendered verbatim in
    /// the completion line `Background command "<name>" completed
    /// (exit code N)`. `None` for tasks that never terminated or
    /// for non-Shell kinds where exit code doesn't apply.
    pub exit_code: Option<i32>,
    /// LLM-emitted `tool_use_id` of the originating tool call. Set
    /// when the task was spawned via the Agent tool's BG route so
    /// the `<task-notification>` injected on the next turn can
    /// populate `<tool-use-id>` — the model uses that tag to
    /// reconcile the notification against its own `tool_use` block
    /// in history. Mirrors upstream's `taskId` (this `id`) +
    /// `toolUseId` (this field) twin tracked on
    /// `LocalAgentTaskState` (`tasks/LocalAgentTask/
    /// LocalAgentTask.tsx:466-514`). `None` for shell tasks
    /// (no originating tool_use) and tasks created before this
    /// field landed.
    pub tool_use_id: Option<String>,
    /// `true` once the TUI has emitted the ephemeral completion
    /// line into the transcript (e.g. `Background command "<name>"
    /// completed`). Detector flips this on first paint to ensure
    /// the line shows once even though the tick poll runs every
    /// 50 ms. Cannot push from `spawn::finalize` (the runner runs
    /// on `spawn_blocking` and has no handle on the TUI thread);
    /// state.rs ticker owns the push + flag transition.
    pub rendered_completion_line: bool,
}

impl TaskRecord {
    /// Bound on [`Self::output`] — 200 lines covers enough scrollback
    /// for the detail view without unbounded growth.
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
            rendered_completion_line: false,
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
            rendered_completion_line: false,
        }
    }

    /// Append a single line to the output buffer, evicting the
    /// oldest when the bound is reached.
    pub fn push_output(&mut self, line: String) {
        if self.output.len() >= Self::OUTPUT_CAPACITY {
            self.output.pop_front();
        }
        self.output.push_back(line);
    }

    /// Wall clock seconds since `started_at`. Rounded for the
    /// detail-view `Runtime:` row.
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
        // Oldest should be line 50 (first 50 evicted).
        assert_eq!(r.output.front().map(String::as_str), Some("line 50"));
    }
}
