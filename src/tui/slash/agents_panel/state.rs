use crate::agent::subagents::registry::AgentDefinition;
use crate::tasks::{TaskKind, TaskState, TaskStore};

const RECENTLY_COMPLETED_LIMIT: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Running,
    Library,
}

impl Tab {
    pub fn cycle(self) -> Self {
        match self {
            Tab::Running => Tab::Library,
            Tab::Library => Tab::Running,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunningRow {
    pub name: String,
    pub runtime_secs: u64,
}

#[derive(Debug, Clone)]
pub struct CompletedRow {
    pub name: String,
    pub status: TaskState,
}

#[derive(Debug, Clone)]
pub struct LibraryRow {
    pub name: String,
    pub model: String,
}

#[derive(Debug, Clone)]
pub struct AgentsPanelState {
    pub tab: Tab,
    pub running_cursor: usize,
    pub running: Vec<RunningRow>,
    pub recently_completed: Vec<CompletedRow>,
    pub library: Vec<LibraryRow>,
}

fn short_model_name(model: Option<&str>) -> String {
    let Some(canonical) = model else {
        return "inherit".to_string();
    };
    if canonical.starts_with("claude-opus") {
        "opus".to_string()
    } else if canonical.starts_with("claude-sonnet") {
        "sonnet".to_string()
    } else if canonical.starts_with("claude-haiku") {
        "haiku".to_string()
    } else {
        canonical.to_string()
    }
}

impl AgentsPanelState {
    pub fn new(tasks: &TaskStore, defs: &[AgentDefinition]) -> Self {
        let running: Vec<RunningRow> = tasks
            .list_active()
            .into_iter()
            .filter(|r| matches!(r.kind, TaskKind::Agent))
            .map(|r| RunningRow {
                name: r.name.clone(),
                runtime_secs: r.runtime_secs(),
            })
            .collect();

        let recently_completed: Vec<CompletedRow> = tasks
            .list_recent_terminal(TaskKind::Agent, RECENTLY_COMPLETED_LIMIT)
            .into_iter()
            .map(|r| CompletedRow {
                name: r.name.clone(),
                status: r.state,
            })
            .collect();

        let mut library: Vec<LibraryRow> = defs
            .iter()
            .map(|d| LibraryRow {
                name: d.name.clone(),
                model: short_model_name(d.model.as_deref()),
            })
            .collect();
        library.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        Self {
            tab: Tab::Running,
            running_cursor: 0,
            running,
            recently_completed,
            library,
        }
    }

    pub fn cursor_up(&mut self) {
        if matches!(self.tab, Tab::Running) && !self.running.is_empty() {
            if self.running_cursor > 0 {
                self.running_cursor -= 1;
            } else {
                self.running_cursor = self.running.len() - 1;
            }
        }
    }

    pub fn cursor_down(&mut self) {
        if matches!(self.tab, Tab::Running) && !self.running.is_empty() {
            self.running_cursor = (self.running_cursor + 1) % self.running.len();
        }
    }

    pub fn cycle_tab(&mut self) {
        self.tab = self.tab.cycle();
        if matches!(self.tab, Tab::Running) && self.running_cursor >= self.running.len() {
            self.running_cursor = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::subagents::registry;

    #[test]
    fn default_tab_is_running_to_match_upstream() {
        let store = TaskStore::new();
        let defs = registry::all();
        let st = AgentsPanelState::new(&store, defs);
        assert_eq!(st.tab, Tab::Running);
    }

    #[test]
    fn library_sorted_case_insensitive() {
        let store = TaskStore::new();
        let defs = registry::all();
        let st = AgentsPanelState::new(&store, defs);
        let names: Vec<String> = st.library.iter().map(|r| r.name.to_lowercase()).collect();
        let mut expected = names.clone();
        expected.sort();
        assert_eq!(names, expected);
    }

    #[test]
    fn library_contains_all_bundled_agents() {
        let store = TaskStore::new();
        let defs = registry::all();
        let st = AgentsPanelState::new(&store, defs);
        let names: Vec<&str> = st.library.iter().map(|r| r.name.as_str()).collect();
        for expected in [
            "general-purpose",
            "Explore",
            "Plan",
            "verification",
            "claude-code-guide",
            "statusline-setup",
        ] {
            assert!(
                names.contains(&expected),
                "library missing {expected}: {names:?}"
            );
        }
    }

    #[test]
    fn tab_cycle_toggles_running_and_library() {
        let mut st = AgentsPanelState::new(&TaskStore::new(), registry::all());
        assert_eq!(st.tab, Tab::Running);
        st.cycle_tab();
        assert_eq!(st.tab, Tab::Library);
        st.cycle_tab();
        assert_eq!(st.tab, Tab::Running);
    }

    #[test]
    fn short_model_name_families() {
        assert_eq!(short_model_name(Some("claude-opus-4-7")), "opus");
        assert_eq!(short_model_name(Some("claude-sonnet-4-6")), "sonnet");
        assert_eq!(short_model_name(Some("claude-haiku-4-5")), "haiku");
        assert_eq!(short_model_name(None), "inherit");
    }

    #[test]
    fn short_model_name_unknown_canonical_returns_verbatim() {
        assert_eq!(short_model_name(Some("custom-model-9")), "custom-model-9");
    }

    #[test]
    fn recently_completed_populated_from_terminal_agent_tasks() {
        use crate::tasks::id::TaskId;
        use crate::tasks::state::{TaskRecord, TaskState};
        let store = TaskStore::new();
        let mut r = TaskRecord::new_agent(
            TaskId::from_string("a1"),
            "Quick sanity test agent".into(),
            "prompt".into(),
        );
        r.state = TaskState::Completed;
        store.insert(r);
        let st = AgentsPanelState::new(&store, registry::all());
        assert_eq!(st.recently_completed.len(), 1);
        assert_eq!(st.recently_completed[0].name, "Quick sanity test agent");
        assert!(matches!(
            st.recently_completed[0].status,
            TaskState::Completed
        ));
    }

    #[test]
    fn recently_completed_ignores_shell_tasks() {
        use crate::tasks::id::TaskId;
        use crate::tasks::state::{TaskRecord, TaskState};
        let store = TaskStore::new();
        let mut r = TaskRecord::new_shell(
            TaskId::from_string("s1"),
            "ls".into(),
            "ls".into(),
        );
        r.state = TaskState::Completed;
        store.insert(r);
        let st = AgentsPanelState::new(&store, registry::all());
        assert!(st.recently_completed.is_empty());
    }

    #[test]
    fn cursor_no_op_on_empty_running() {
        let mut st = AgentsPanelState::new(&TaskStore::new(), registry::all());
        assert!(st.running.is_empty());
        st.cursor_down();
        st.cursor_up();
        assert_eq!(st.running_cursor, 0);
    }
}
