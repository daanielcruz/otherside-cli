use std::path::PathBuf;

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
    pub description: Option<String>,
    pub tokens: u64,
    pub subagent_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompletedRow {
    pub name: String,
    pub status: TaskState,
    pub subagent_type: Option<String>,
    pub final_message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LibraryRow {
    pub name: String,
    pub model: String,
    pub running_count: usize,
}

/// User-defined agent discovered on disk under `~/.claude/agents/*.md`.
/// Upstream surfaces these under the `User agents (<path>)` section in
/// the Library tab (AgentsList.tsx). Parsed via the shared frontmatter
/// parser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAgentRow {
    pub name: String,
    pub model: String,
}

pub fn discover_user_agents_dir() -> Option<PathBuf> {
    let base = directories::BaseDirs::new()?;
    Some(base.home_dir().join(".claude").join("agents"))
}

pub fn discover_user_agents() -> Vec<UserAgentRow> {
    let Some(dir) = discover_user_agents_dir() else {
        return Vec::new();
    };
    let Ok(iter) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut rows: Vec<UserAgentRow> = Vec::new();
    for entry in iter.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = crate::agent::subagents::frontmatter::parse(&src) else {
            continue;
        };
        let name = parsed
            .fields
            .get("name")
            .cloned()
            .or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .map(ToString::to_string)
            })
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let model = parsed
            .fields
            .get("model")
            .cloned()
            .unwrap_or_else(|| "inherit".to_string());
        rows.push(UserAgentRow { name, model });
    }
    rows.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    rows
}

#[derive(Debug, Clone)]
pub struct AgentsPanelState {
    pub tab: Tab,
    pub running_cursor: usize,
    pub running: Vec<RunningRow>,
    pub recently_completed: Vec<CompletedRow>,
    pub library: Vec<LibraryRow>,
    pub user_agents: Vec<UserAgentRow>,
    pub user_agents_dir: Option<PathBuf>,
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
        let active_agents: Vec<_> = tasks
            .list_active()
            .into_iter()
            .filter(|r| matches!(r.kind, TaskKind::Agent))
            .collect();

        let running: Vec<RunningRow> = active_agents
            .iter()
            .map(|r| RunningRow {
                name: r.name.clone(),
                runtime_secs: r.runtime_secs(),
                description: r.description.clone(),
                tokens: r.tokens,
                subagent_type: r.subagent_type.clone(),
            })
            .collect();

        use std::collections::HashMap;
        let mut running_by_type: HashMap<String, usize> = HashMap::new();
        for r in &active_agents {
            if let Some(st) = r.subagent_type.as_deref() {
                *running_by_type.entry(st.to_string()).or_insert(0) += 1;
            }
        }

        let recently_completed: Vec<CompletedRow> = tasks
            .list_recent_terminal(TaskKind::Agent, RECENTLY_COMPLETED_LIMIT)
            .into_iter()
            .map(|r| CompletedRow {
                name: r.name.clone(),
                status: r.state,
                subagent_type: r.subagent_type.clone(),
                final_message: r.description.clone(),
            })
            .collect();

        let mut library: Vec<LibraryRow> = defs
            .iter()
            .map(|d| LibraryRow {
                name: d.name.clone(),
                model: short_model_name(d.model.as_deref()),
                running_count: *running_by_type.get(&d.name).unwrap_or(&0),
            })
            .collect();
        library.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        Self {
            tab: Tab::Running,
            running_cursor: 0,
            running,
            recently_completed,
            library,
            user_agents: discover_user_agents(),
            user_agents_dir: discover_user_agents_dir(),
        }
    }

    /// Re-pull live state from the TaskStore without dropping user UI
    /// selection (tab + cursor). Called each draw tick so a subagent
    /// dispatched AFTER the panel opened surfaces immediately, and a
    /// completion flips the row into the Recent tab without the user
    /// needing to /agents again.
    pub fn refresh(&mut self, tasks: &TaskStore, defs: &[AgentDefinition]) {
        let active_agents: Vec<_> = tasks
            .list_active()
            .into_iter()
            .filter(|r| matches!(r.kind, TaskKind::Agent))
            .collect();

        self.running = active_agents
            .iter()
            .map(|r| RunningRow {
                name: r.name.clone(),
                runtime_secs: r.runtime_secs(),
                description: r.description.clone(),
                tokens: r.tokens,
                subagent_type: r.subagent_type.clone(),
            })
            .collect();
        if self.running_cursor >= self.running.len() {
            self.running_cursor = self.running.len().saturating_sub(1);
        }

        use std::collections::HashMap;
        let mut running_by_type: HashMap<String, usize> = HashMap::new();
        for r in &active_agents {
            if let Some(st) = r.subagent_type.as_deref() {
                *running_by_type.entry(st.to_string()).or_insert(0) += 1;
            }
        }

        self.recently_completed = tasks
            .list_recent_terminal(TaskKind::Agent, RECENTLY_COMPLETED_LIMIT)
            .into_iter()
            .map(|r| CompletedRow {
                name: r.name.clone(),
                status: r.state,
                subagent_type: r.subagent_type.clone(),
                final_message: r.description.clone(),
            })
            .collect();

        self.library = defs
            .iter()
            .map(|d| LibraryRow {
                name: d.name.clone(),
                model: short_model_name(d.model.as_deref()),
                running_count: *running_by_type.get(&d.name).unwrap_or(&0),
            })
            .collect();
        self.library
            .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
            "statusline-setup",
        ] {
            assert!(
                names.contains(&expected),
                "library missing {expected}: {names:?}"
            );
        }
    }

    #[test]
    fn running_row_carries_description_and_tokens_from_record() {
        let store = TaskStore::new();
        let mut record = crate::tasks::TaskRecord::new_agent(
            crate::tasks::TaskId::from_string("tid-1"),
            "Explore".to_string(),
            "prompt body".to_string(),
        );
        record.description = Some("Quick lookup".into());
        record.tokens = 1234;
        store.insert(record);
        let defs = registry::all();
        let st = AgentsPanelState::new(&store, defs);
        let row = st.running.first().expect("running row present");
        assert_eq!(row.description.as_deref(), Some("Quick lookup"));
        assert_eq!(row.tokens, 1234);
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
    fn library_row_running_count_populated_from_subagent_type() {
        use crate::tasks::id::TaskId;
        use crate::tasks::state::TaskRecord;
        let store = TaskStore::new();
        let mut r = TaskRecord::new_agent(
            TaskId::from_string("a9"),
            "running job".into(),
            "prompt".into(),
        );
        r.subagent_type = Some("general-purpose".into());
        store.insert(r);
        let st = AgentsPanelState::new(&store, registry::all());
        let gp = st
            .library
            .iter()
            .find(|l| l.name == "general-purpose")
            .expect("general-purpose in library");
        assert_eq!(gp.running_count, 1);
        let explore = st
            .library
            .iter()
            .find(|l| l.name == "Explore")
            .expect("Explore in library");
        assert_eq!(explore.running_count, 0);
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
