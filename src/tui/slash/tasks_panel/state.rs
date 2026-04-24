use crate::tasks::{TaskKind, TaskRecord, TaskState, TaskStore};

#[derive(Debug, Clone)]
pub enum Mode {
    List,
    Detail(usize), 
}

#[derive(Debug, Clone)]
pub struct TaskRow {
    pub name: String,
    pub description: Option<String>,
    pub subagent_type: Option<String>,
    pub kind: TaskKind,
    pub state: TaskState,
    pub runtime_secs: u64,
    pub tokens: u64,
    pub output: Vec<String>,
    
    pub prompt: String,
    pub tool_use_id: Option<String>,
    pub error: Option<String>,
}

impl From<&TaskRecord> for TaskRow {
    fn from(r: &TaskRecord) -> Self {
        let prompt = match r.kind {
            TaskKind::Agent => extract_agent_prompt_field(&r.command),
            _ => r.command.clone(),
        };
        Self {
            name: r.name.clone(),
            description: r.description.clone(),
            subagent_type: r.subagent_type.clone(),
            kind: r.kind,
            state: r.state,
            runtime_secs: r.runtime_secs(),
            tokens: r.tokens,
            output: r.output.iter().cloned().collect(),
            prompt,
            tool_use_id: r.tool_use_id.clone(),
            error: r.error.clone(),
        }
    }
}

fn extract_agent_prompt_field(command: &str) -> String {
    let trimmed = command.trim();
    if !trimmed.starts_with('{') {
        return command.to_string();
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(v) => v
            .get("prompt")
            .and_then(|p| p.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| command.to_string()),
        Err(_) => command.to_string(),
    }
}

#[derive(Debug, Clone)]
pub struct TasksPanelState {
    pub mode: Mode,
    pub cursor: usize,
    pub rows: Vec<TaskRow>,
    
    pub came_from_list: bool,
}

impl TasksPanelState {
    pub fn new(tasks: &TaskStore) -> Self {
        let rows: Vec<TaskRow> =
            tasks.list_active().iter().map(TaskRow::from).collect();

        let mode = if rows.len() == 1 {
            Mode::Detail(0)
        } else {
            Mode::List
        };

        Self {
            mode,
            cursor: 0,
            rows,
            came_from_list: false,
        }
    }

    pub fn refresh(&mut self, tasks: &TaskStore) {
        let fresh: Vec<TaskRow> =
            tasks.list_active().iter().map(TaskRow::from).collect();
        self.rows = fresh;
        if self.cursor >= self.rows.len() {
            self.cursor = self.rows.len().saturating_sub(0).saturating_sub(1);
        }
        
        if let Mode::Detail(idx) = self.mode {
            if idx >= self.rows.len() {
                self.mode = Mode::List;
                self.cursor = 0;
            }
        }
    }

    pub fn cursor_up(&mut self) {
        if self.rows.is_empty() {
            return;
        }
        self.cursor = if self.cursor == 0 {
            self.rows.len() - 1
        } else {
            self.cursor - 1
        };
    }

    pub fn cursor_down(&mut self) {
        if self.rows.is_empty() {
            return;
        }
        self.cursor = (self.cursor + 1) % self.rows.len();
    }

    pub fn enter_detail(&mut self) -> bool {
        if self.rows.is_empty() {
            return false;
        }
        if let Mode::List = self.mode {
            self.mode = Mode::Detail(self.cursor);
            self.came_from_list = true;
            true
        } else {
            false
        }
    }

    pub fn back_to_list(&mut self) -> bool {
        if let Mode::Detail(idx) = self.mode {
            self.cursor = idx.min(self.rows.len().saturating_sub(1));
            self.mode = Mode::List;
            self.came_from_list = false;
            true
        } else {
            false
        }
    }

    pub fn focused_row(&self) -> Option<&TaskRow> {
        match self.mode {
            Mode::Detail(idx) => self.rows.get(idx),
            Mode::List => self.rows.get(self.cursor),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{TaskId, TaskRecord as TR};

    fn store_with_two_agents() -> TaskStore {
        let s = TaskStore::new();
        let mut r1 = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "write a summary".into(),
        );
        r1.subagent_type = Some("general-purpose".into());
        r1.description = Some("summary".into());
        r1.tokens = 1234;
        s.insert(r1);
        let mut r2 = TR::new_agent(
            TaskId::generate(),
            "verification".into(),
            "verify pr".into(),
        );
        r2.subagent_type = Some("verification".into());
        r2.description = Some("verify".into());
        s.insert(r2);
        s
    }

    #[test]
    fn single_task_auto_skips_to_detail() {
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "solo".into(),
            "sleep".into(),
        );
        r.subagent_type = Some("general-purpose".into());
        s.insert(r);
        let state = TasksPanelState::new(&s);
        assert!(matches!(state.mode, Mode::Detail(0)));
    }

    #[test]
    fn multi_task_lands_in_list_mode() {
        let s = store_with_two_agents();
        let state = TasksPanelState::new(&s);
        assert!(matches!(state.mode, Mode::List));
        assert_eq!(state.rows.len(), 2);
        assert_eq!(state.cursor, 0);
    }

    #[test]
    fn enter_from_list_drills_to_detail_at_cursor() {
        let s = store_with_two_agents();
        let mut state = TasksPanelState::new(&s);
        state.cursor_down();
        state.enter_detail();
        assert!(matches!(state.mode, Mode::Detail(1)));
    }

    #[test]
    fn back_from_detail_returns_to_list() {
        let s = store_with_two_agents();
        let mut state = TasksPanelState::new(&s);
        state.cursor_down();
        state.enter_detail();
        assert!(state.back_to_list());
        assert!(matches!(state.mode, Mode::List));
    }

    #[test]
    fn cursor_wraps_both_directions() {
        let s = store_with_two_agents();
        let mut state = TasksPanelState::new(&s);
        state.cursor_up();
        assert_eq!(state.cursor, 1);
        state.cursor_down();
        assert_eq!(state.cursor, 0);
    }
}
