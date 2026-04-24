
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use super::id::TaskId;
use super::state::{TaskKind, TaskRecord, TaskState};

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

static GLOBAL: OnceLock<TaskStore> = OnceLock::new();

pub fn install_global(store: TaskStore) -> TaskStore {
    if let Err(existing) = GLOBAL.set(store.clone()) {
        let _ = existing;
        return GLOBAL.get().cloned().expect("OnceLock populated");
    }
    store
}

pub fn current_global() -> Option<TaskStore> {
    GLOBAL.get().cloned()
}

impl TaskStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, record: TaskRecord) -> TaskId {
        let id = record.id.clone();
        self.inner
            .write()
            .expect("task store rwlock poisoned")
            .insert(id.clone(), record);
        id
    }

    pub fn get(&self, id: &TaskId) -> Option<TaskRecord> {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .get(id)
            .cloned()
    }

    pub fn task_id_by_tool_use_id(&self, tool_use_id: &str) -> Option<TaskId> {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .find(|r| r.tool_use_id.as_deref() == Some(tool_use_id))
            .map(|r| r.id.clone())
    }

    pub fn list(&self) -> Vec<TaskRecord> {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .cloned()
            .collect()
    }

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

    pub fn list_recent_terminal(&self, kind: TaskKind, limit: usize) -> Vec<TaskRecord> {
        if limit == 0 {
            return Vec::new();
        }
        let mut v: Vec<TaskRecord> = self
            .inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .filter(|r| r.kind == kind && r.state.is_terminal())
            .cloned()
            .collect();
        v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        v.truncate(limit);
        v
    }

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

    pub fn counts_backgrounded(&self) -> TaskCounts {
        let map = self.inner.read().expect("task store rwlock poisoned");
        let mut c = TaskCounts::default();
        for r in map.values() {
            if !r.is_backgrounded || r.state.is_terminal() {
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

    pub fn any_running_foreground(&self) -> bool {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .any(|r| matches!(r.state, TaskState::Running) && !r.is_backgrounded)
    }

    pub fn accumulate_tokens(&self, id: &TaskId, delta: u64) {
        let mut map = self.inner.write().expect("task store rwlock poisoned");
        if let Some(r) = map.get_mut(id) {
            r.tokens = r.tokens.saturating_add(delta);
        }
    }

    pub fn push_progress_line(&self, id: &TaskId, line: String) {
        let mut map = self.inner.write().expect("task store rwlock poisoned");
        if let Some(r) = map.get_mut(id) {
            r.push_output(line);
            r.tool_uses = r.tool_uses.saturating_add(1);
        }
    }

    pub fn any_backgrounded(&self) -> bool {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .any(|r| r.is_backgrounded && !r.state.is_terminal())
    }

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

    pub fn drain_unrendered_completions(&self) -> Vec<TaskRecord> {
        let mut map = self.inner.write().expect("task store rwlock poisoned");
        let mut out = Vec::new();
        for r in map.values_mut() {
            if r.state.is_terminal() && !r.rendered_completion_line {
                r.rendered_completion_line = true;
                out.push(r.clone());
            }
        }
        out
    }

    pub fn has_pending_notifications(&self) -> bool {
        self.inner
            .read()
            .expect("task store rwlock poisoned")
            .values()
            .any(|r| r.inject_on_next_turn)
    }

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
    fn counts_backgrounded_ignores_foreground_running_agent() {
        
        let s = TaskStore::new();
        s.insert({
            let mut r = agent("fg-running");
            r.is_backgrounded = false;
            r.state = TaskState::Running;
            r
        });
        assert_eq!(s.counts_backgrounded().agents, 0);
        assert_eq!(s.counts_active().agents, 1, "foreground still counts as active");
    }

    #[test]
    fn counts_backgrounded_counts_flipped_agent_until_terminal() {
        
        let s = TaskStore::new();
        s.insert({
            let mut r = agent("just-backgrounded");
            r.is_backgrounded = true;
            r.state = TaskState::Backgrounded;
            r
        });
        assert_eq!(s.counts_backgrounded().agents, 1);

        let id = s.counts_backgrounded();
        assert_eq!(id.agents, 1);
        let records: Vec<_> = s
            .inner
            .read()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for id in records {
            s.update_with(&id, |r| {
                r.state = TaskState::Completed;
            });
        }
        assert_eq!(s.counts_backgrounded().agents, 0);
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
    fn has_pending_notifications_returns_true_only_when_flag_set() {
        let s = TaskStore::new();
        assert!(!s.has_pending_notifications(), "empty store has no pendings");
        s.insert(shell("running"));
        assert!(!s.has_pending_notifications(), "running task without inject flag is not a pending");
        let id = s.insert({
            let mut r = shell("done");
            r.state = TaskState::Completed;
            r.inject_on_next_turn = true;
            r
        });
        assert!(s.has_pending_notifications(), "completed + flag => pending");
        s.update_with(&id, |r| r.inject_on_next_turn = false);
        assert!(!s.has_pending_notifications(), "flag cleared => no longer pending");
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
