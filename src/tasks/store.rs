//! `TaskStore` — concurrent in-memory store of [`TaskRecord`]s.
//!
//! Single source of truth for "what tasks exist + what's their
//! state". Mutated from two sides:
//!
//! - **Spawner side** (runner on `tokio::spawn`): inserts on spawn,
//!   appends output via `update_with`, transitions to terminal on
//!   completion.
//! - **TUI side** (event loop): reads via `list` / `get` for render +
//!   pill + dialog; mutates via `mark_backgrounded` (Ctrl+B) and
//!   `mark_stopped` (`x` in dialog).
//!
//! Locking discipline:
//! - All write paths take a short-lived `write()` guard.
//! - All read paths take `read()`. Render path holds the guard for
//!   the duration of one frame draw — short.
//! - Never await while holding either guard (R-107 corollary).

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use super::id::TaskId;
use super::state::{TaskKind, TaskRecord, TaskState};

/// Counts grouped by kind — driver of pill label form. Returned
/// from [`TaskStore::counts_active`] so callers don't iterate the
/// full map themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TaskCounts {
    pub shells: usize,
    pub agents: usize,
    pub generic: usize,
}

impl TaskCounts {
    pub fn total(&self) -> usize {
        self.shells + self.agents + self.generic
    }

    /// True when more than one kind is non-zero — pill label uses
    /// the aggregate "N background tasks" form in that case.
    pub fn is_mixed(&self) -> bool {
        let kinds = (self.shells > 0) as u8
            + (self.agents > 0) as u8
            + (self.generic > 0) as u8;
        kinds > 1
    }
}

#[derive(Debug, Clone, Default)]
pub struct TaskStore {
    inner: Arc<RwLock<HashMap<TaskId, TaskRecord>>>,
}

/// Process-global [`TaskStore`] handle installed by the TUI boot
/// path. Tool dispatchers (Agent tool's background route, the
/// deferred Task* tools landing in §9) and the provider request
/// builder (for draining pending `<task-notification>` injections
/// on the next turn) reach the live store through this OnceLock.
/// Mirrors the `crate::subagents::current_runner` pattern.
static GLOBAL: OnceLock<TaskStore> = OnceLock::new();

/// Install the process-global store. First call wins — subsequent
/// calls return the existing store (OnceLock semantics) so
/// re-entering the TUI within a test harness doesn't double-install.
pub fn install_global(store: TaskStore) -> TaskStore {
    if let Err(existing) = GLOBAL.set(store.clone()) {
        let _ = existing;
        return GLOBAL.get().cloned().expect("OnceLock populated");
    }
    store
}

/// Access the process-global store. `None` when the TUI boot path
/// didn't install one (test-harness dispatchers + the `serve`
/// subcommand currently skip installation).
pub fn current_global() -> Option<TaskStore> {
    GLOBAL.get().cloned()
}

impl TaskStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a fresh record. Caller is responsible for generating
    /// a non-colliding id (use [`TaskId::generate`]). Returns the
    /// id back for ergonomic chaining.
    pub fn insert(&self, record: TaskRecord) -> TaskId {
        let id = record.id.clone();
        self.inner
            .write()
            .expect("task store rwlock poisoned")
            .insert(id.clone(), record);
        id
    }

    /// Snapshot read of one record. Returns `None` for unknown id.
    /// Clones — caller doesn't hold the lock.
    pub fn get(&self, id: &TaskId) -> Option<TaskRecord> {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .get(id)
            .cloned()
    }

    /// Snapshot list of all records. Order is map-iteration —
    /// callers that need stable ordering sort by `started_at`.
    pub fn list(&self) -> Vec<TaskRecord> {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .cloned()
            .collect()
    }

    /// Active records sorted oldest-first. Used by the dialog list
    /// view + the pill counts.
    pub fn list_active(&self) -> Vec<TaskRecord> {
        let mut v: Vec<TaskRecord> = self
            .inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .filter(|r| r.state.is_active())
            .cloned()
            .collect();
        v.sort_by_key(|r| r.started_at);
        v
    }

    /// Counts grouped by kind, restricted to active records. Pill
    /// render calls this every frame.
    pub fn counts_active(&self) -> TaskCounts {
        let map = self.inner.read().expect("task store rwlock poisoned");
        let mut c = TaskCounts::default();
        for r in map.values() {
            if !r.state.is_active() {
                continue;
            }
            match r.kind {
                TaskKind::Shell => c.shells += 1,
                TaskKind::Agent => c.agents += 1,
                TaskKind::Generic => c.generic += 1,
            }
        }
        c
    }

    /// Mutate a record by id. Returns `true` if found + applied.
    /// Closure receives `&mut TaskRecord` — keep the body short
    /// (no awaits).
    pub fn update_with<F: FnOnce(&mut TaskRecord)>(&self, id: &TaskId, f: F) -> bool {
        let mut map = self.inner.write().expect("task store rwlock poisoned");
        match map.get_mut(id) {
            Some(r) => {
                f(r);
                true
            }
            None => false,
        }
    }

    /// Predicate for the Ctrl+B keybinding's `is_active` gate —
    /// only fire `task:background` when there's at least one
    /// non-backgrounded running task to flip.
    pub fn any_running_foreground(&self) -> bool {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .any(|r| matches!(r.state, TaskState::Running) && !r.is_backgrounded)
    }

    /// `Ctrl+B` action — flip every Running foreground task to
    /// Backgrounded. Mirrors `LocalShellTask.tsx:400-429`
    /// `backgroundAll`. Returns the count of tasks flipped (caller
    /// renders the `Started in background as <id>.` line per
    /// flipped task).
    pub fn background_all_running_foreground(&self) -> Vec<TaskId> {
        let mut map = self.inner.write().expect("task store rwlock poisoned");
        let mut flipped = Vec::new();
        for (id, r) in map.iter_mut() {
            if matches!(r.state, TaskState::Running) && !r.is_backgrounded {
                r.is_backgrounded = true;
                r.state = TaskState::Backgrounded;
                flipped.push(id.clone());
            }
        }
        flipped
    }

    /// Drain records flagged `inject_on_next_turn = true`,
    /// clearing the flag on each. Returns owned snapshots so the
    /// caller can render `<task-notification>` blocks without
    /// holding the lock during XML assembly.
    pub fn drain_pending_notifications(&self) -> Vec<TaskRecord> {
        let mut map = self.inner.write().expect("task store rwlock poisoned");
        let mut out = Vec::new();
        for r in map.values_mut() {
            if r.inject_on_next_turn {
                r.inject_on_next_turn = false;
                out.push(r.clone());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(name: &str) -> TaskRecord {
        TaskRecord::new_shell(
            TaskId::generate(),
            name.into(),
            format!("echo {name}"),
        )
    }

    fn agent(name: &str) -> TaskRecord {
        TaskRecord::new_agent(
            TaskId::generate(),
            name.into(),
            format!("prompt for {name}"),
        )
    }

    #[test]
    fn insert_then_get_round_trips() {
        let s = TaskStore::new();
        let r = shell("t");
        let id = r.id.clone();
        s.insert(r);
        let back = s.get(&id).expect("get returns inserted record");
        assert_eq!(back.id, id);
        assert_eq!(back.name, "t");
    }

    #[test]
    fn counts_active_groups_by_kind() {
        let s = TaskStore::new();
        s.insert(shell("a"));
        s.insert(shell("b"));
        s.insert(agent("z"));
        let c = s.counts_active();
        assert_eq!(c.shells, 2);
        assert_eq!(c.agents, 1);
        assert_eq!(c.generic, 0);
        assert_eq!(c.total(), 3);
        assert!(c.is_mixed());
    }

    #[test]
    fn background_all_flips_running_only() {
        let s = TaskStore::new();
        let id_run = s.insert(shell("running"));
        let id_done = s.insert({
            let mut r = shell("already-done");
            r.state = TaskState::Completed;
            r
        });
        let flipped = s.background_all_running_foreground();
        assert_eq!(flipped, vec![id_run.clone()]);
        let r = s.get(&id_run).unwrap();
        assert!(r.is_backgrounded);
        assert_eq!(r.state, TaskState::Backgrounded);
        assert!(!s.get(&id_done).unwrap().is_backgrounded);
    }

    #[test]
    fn any_running_foreground_skips_backgrounded() {
        let s = TaskStore::new();
        s.insert({
            let mut r = shell("bg");
            r.is_backgrounded = true;
            r.state = TaskState::Backgrounded;
            r
        });
        assert!(!s.any_running_foreground(), "backgrounded must NOT count");
        s.insert(shell("fg"));
        assert!(s.any_running_foreground(), "fresh foreground task counts");
    }

    #[test]
    fn drain_pending_notifications_clears_flag() {
        let s = TaskStore::new();
        let id = s.insert({
            let mut r = shell("done");
            r.state = TaskState::Completed;
            r.inject_on_next_turn = true;
            r
        });
        let drained = s.drain_pending_notifications();
        assert_eq!(drained.len(), 1);
        assert!(!s.get(&id).unwrap().inject_on_next_turn);
        assert!(
            s.drain_pending_notifications().is_empty(),
            "second drain finds no pending"
        );
    }

    #[test]
    fn list_active_filters_terminal_states() {
        let s = TaskStore::new();
        s.insert(shell("running"));
        s.insert({
            let mut r = shell("done");
            r.state = TaskState::Completed;
            r
        });
        s.insert({
            let mut r = shell("failed");
            r.state = TaskState::Failed;
            r
        });
        let active = s.list_active();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].name, "running");
    }
}
