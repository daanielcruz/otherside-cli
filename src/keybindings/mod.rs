

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::tasks::TaskStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {

    TaskBackground,

    OpenBackgroundTasksDialog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Context {

    Tui,

    Dialog,

    Input,

    Global,
}

impl Context {

    pub fn priority(self) -> u8 {
        match self {
            Self::Input => 0,
            Self::Dialog => 1,
            Self::Tui => 2,
            Self::Global => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyCombo {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
}

impl KeyCombo {
    pub const fn new(code: KeyCode, modifiers: KeyModifiers) -> Self {
        Self { code, modifiers }
    }

    pub fn matches(&self, event: &KeyEvent) -> bool {
        event.code == self.code && event.modifiers == self.modifiers
    }
}

pub struct PredicateContext<'a> {
    pub tasks: &'a TaskStore,

    pub dialog_open: bool,
}

pub struct Binding {
    pub action: Action,
    pub keys: KeyCombo,
    pub context: Context,
    pub is_active: fn(&PredicateContext<'_>) -> bool,
}

impl Binding {

    fn fires(&self, event: &KeyEvent, ctx: &PredicateContext<'_>) -> bool {
        if !self.keys.matches(event) {
            return false;
        }

        let context_active = match self.context {
            Context::Tui => !ctx.dialog_open,
            Context::Dialog => ctx.dialog_open,
            Context::Input => true,
            Context::Global => true,
        };
        if !context_active {
            return false;
        }
        (self.is_active)(ctx)
    }
}

fn any_running_foreground(ctx: &PredicateContext<'_>) -> bool {
    if crate::tasks::is_disabled() {
        return false;
    }
    ctx.tasks.any_running_foreground()
}

fn any_backgrounded(ctx: &PredicateContext<'_>) -> bool {
    if crate::tasks::is_disabled() {
        return false;
    }
    ctx.tasks
        .list_active()
        .into_iter()
        .any(|r| r.is_backgrounded)
}

pub fn default_bindings() -> &'static [Binding] {
    use crossterm::event::{KeyCode::Char, KeyCode::Down};
    static BINDINGS: &[Binding] = &[
        Binding {
            action: Action::TaskBackground,
            keys: KeyCombo::new(Char('b'), KeyModifiers::CONTROL),
            context: Context::Tui,
            is_active: any_running_foreground,
        },
        Binding {
            action: Action::OpenBackgroundTasksDialog,
            keys: KeyCombo::new(Down, KeyModifiers::SHIFT),
            context: Context::Tui,
            is_active: any_backgrounded,
        },
    ];
    BINDINGS
}

pub fn dispatch(event: &KeyEvent, ctx: &PredicateContext<'_>) -> Option<Action> {
    let mut candidates: Vec<&Binding> = default_bindings()
        .iter()
        .filter(|b| b.fires(event, ctx))
        .collect();
    candidates.sort_by_key(|b| b.context.priority());
    candidates.first().map(|b| b.action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{TaskId, TaskRecord, TaskState};

    fn ctx_with_tasks(store: TaskStore, dialog_open: bool) -> PredicateContext<'static> {

        let leaked: &'static TaskStore = Box::leak(Box::new(store));
        PredicateContext {
            tasks: leaked,
            dialog_open,
        }
    }

    fn ctrl_b() -> KeyEvent {
        KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL)
    }

    fn shift_down() -> KeyEvent {
        KeyEvent::new(KeyCode::Down, KeyModifiers::SHIFT)
    }

    fn fresh_running_shell() -> TaskRecord {
        TaskRecord::new_shell(TaskId::generate(), "t".into(), "echo".into())
    }

    #[test]
    fn ctrl_b_dispatches_when_running_foreground_exists() {
        let store = TaskStore::new();
        store.insert(fresh_running_shell());
        let ctx = ctx_with_tasks(store, false);
        assert_eq!(dispatch(&ctrl_b(), &ctx), Some(Action::TaskBackground));
    }

    #[test]
    fn ctrl_b_no_op_when_no_running_task() {
        let store = TaskStore::new();
        let ctx = ctx_with_tasks(store, false);
        assert_eq!(dispatch(&ctrl_b(), &ctx), None);
    }

    #[test]
    fn ctrl_b_no_op_when_dialog_open() {
        let store = TaskStore::new();
        store.insert(fresh_running_shell());
        let ctx = ctx_with_tasks(store, true);
        assert_eq!(
            dispatch(&ctrl_b(), &ctx),
            None,
            "Tui-context binding must NOT fire while a dialog has focus"
        );
    }

    #[test]
    fn shift_down_dispatches_when_backgrounded_exists() {
        let store = TaskStore::new();
        let mut r = fresh_running_shell();
        r.is_backgrounded = true;
        r.state = TaskState::Backgrounded;
        store.insert(r);
        let ctx = ctx_with_tasks(store, false);
        assert_eq!(
            dispatch(&shift_down(), &ctx),
            Some(Action::OpenBackgroundTasksDialog)
        );
    }

    #[test]
    fn shift_down_no_op_when_only_foreground_tasks() {
        let store = TaskStore::new();
        store.insert(fresh_running_shell());
        let ctx = ctx_with_tasks(store, false);
        assert_eq!(dispatch(&shift_down(), &ctx), None);
    }

    #[test]
    fn context_priority_input_wins_over_global() {
        assert!(Context::Input.priority() < Context::Global.priority());
        assert!(Context::Dialog.priority() < Context::Tui.priority());
    }
}
