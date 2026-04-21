//! Mini keybinding registry — port of upstream's
//! `keybindings/defaultBindings.ts` shape.
//!
//! Why a registry instead of a hardcoded `match` block in the event
//! loop:
//!
//! - Bindings carry a `context` (where the binding is active —
//!   main TUI, dialog, input field) and an `is_active` predicate
//!   (gate a binding on session state, e.g. Ctrl+B only when a
//!   running foreground task exists). A registry centralizes both
//!   so adding a binding is one line, and gating logic doesn't
//!   sprawl across the keypress handler.
//!
//! - Upstream uses the same shape: `{action, keys, context,
//!   isActive}` lookup at every keypress. Mirroring it keeps the
//!   parity story honest — when upstream adds a new contextual
//!   binding the port becomes a registry entry, not an event-loop
//!   diff.
//!
//! # Scope
//!
//! Wave-1 (openspec 015) seeds two bindings:
//! - `Ctrl+B` → `Action::TaskBackground` (context Tui, gated on
//!   any running foreground task).
//! - `Shift+↓` → `Action::OpenBackgroundTasksDialog` (context Tui,
//!   gated on any backgrounded task — the navigation hint
//!   `↓ to manage`).
//!
//! Future bindings register via [`default_bindings`] without
//! touching dispatch.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::tasks::TaskStore;

/// User-facing actions the registry can dispatch. One enum value per
/// keybinding the TUI honors. Add new variants here, never overload
/// existing ones — the dispatch + handler match arms key off this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Ctrl+B — background every running foreground task.
    /// Source: `keybindings/defaultBindings.ts:196-202`,
    /// `LocalShellTask.tsx:400-429` `backgroundAll`.
    TaskBackground,
    /// Shift+↓ — open the BackgroundTasksDialog directly when only
    /// non-teammate backgrounded tasks exist. Source:
    /// `hooks/useBackgroundTaskNavigation.ts:62-83`.
    OpenBackgroundTasksDialog,
}

/// Where a binding is reachable. Narrower contexts win in dispatch
/// — a `Dialog` binding suppresses the same chord wired to `Tui`
/// when a dialog has focus.
///
/// Mirrors upstream's `defaultBindings.ts:context` field. Only the
/// variants we currently honor live here; expand as wave-2+
/// bindings land.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Context {
    /// Top-level TUI — prompt bar focused, no overlay open.
    Tui,
    /// Modal dialog has focus (e.g. BackgroundTasksDialog).
    Dialog,
    /// Input field-specific binding (rare). Highest priority.
    Input,
    /// Any context. Lowest priority — fires only if no narrower
    /// binding matched.
    Global,
}

impl Context {
    /// Sort priority — lower numbers dispatch first. Input wins
    /// over Dialog wins over Tui wins over Global.
    pub fn priority(self) -> u8 {
        match self {
            Self::Input => 0,
            Self::Dialog => 1,
            Self::Tui => 2,
            Self::Global => 3,
        }
    }
}

/// One key combination — chord-free for now. Wave-1 has no
/// chord bindings; the structure is forward-compat for `Ctrl+X
/// Ctrl+K` later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyCombo {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
}

impl KeyCombo {
    pub const fn new(code: KeyCode, modifiers: KeyModifiers) -> Self {
        Self { code, modifiers }
    }

    /// True when `event` matches this combo.
    pub fn matches(&self, event: &KeyEvent) -> bool {
        event.code == self.code && event.modifiers == self.modifiers
    }
}

/// Snapshot of the bits of state a binding's `is_active` predicate
/// can read. Kept as a slim view so the registry doesn't depend on
/// the full `ConversationState` / `AppState` shape — easier to
/// swap when the AppState aggregate (Fase 3 of state carve) lands.
pub struct PredicateContext<'a> {
    pub tasks: &'a TaskStore,
    /// True when an `OverlayMenu` (any flavor) currently captures
    /// focus. Disambiguates `Tui` vs `Dialog` context.
    pub dialog_open: bool,
}

/// One registered binding.
pub struct Binding {
    pub action: Action,
    pub keys: KeyCombo,
    pub context: Context,
    pub is_active: fn(&PredicateContext<'_>) -> bool,
}

impl Binding {
    /// True when this binding should fire for `event` in the
    /// current state. Used by [`dispatch`].
    fn fires(&self, event: &KeyEvent, ctx: &PredicateContext<'_>) -> bool {
        if !self.keys.matches(event) {
            return false;
        }
        // Context gate: if a dialog is open and this binding's
        // context is `Tui`, suppress (the dialog gets the chord).
        // Conversely, if no dialog is open and this binding wants
        // `Dialog`, suppress.
        let context_active = match self.context {
            Context::Tui => !ctx.dialog_open,
            Context::Dialog => ctx.dialog_open,
            Context::Input => true, // input bindings are always Tui-shape
            Context::Global => true,
        };
        if !context_active {
            return false;
        }
        (self.is_active)(ctx)
    }
}

/// Predicates — kept as `fn` (not closure) so [`Binding`] is `Copy`-
/// friendly + can live in a `&'static` slice.

fn any_running_foreground(ctx: &PredicateContext<'_>) -> bool {
    ctx.tasks.any_running_foreground()
}

fn any_backgrounded(ctx: &PredicateContext<'_>) -> bool {
    ctx.tasks
        .list_active()
        .into_iter()
        .any(|r| r.is_backgrounded)
}

/// Wave-1 binding seed. Ordering is irrelevant — dispatch sorts
/// by [`Context::priority`].
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

/// Pick the highest-priority matching binding for `event` given
/// the current state. Returns the [`Action`] to dispatch, or
/// `None` if no binding fires.
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
        // SAFETY shim for tests: PredicateContext borrows; for ergonomic
        // tests we Box-leak a store so the borrow lasts. Test-only.
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
        store.insert(fresh_running_shell()); // foreground only
        let ctx = ctx_with_tasks(store, false);
        assert_eq!(dispatch(&shift_down(), &ctx), None);
    }

    #[test]
    fn context_priority_input_wins_over_global() {
        assert!(Context::Input.priority() < Context::Global.priority());
        assert!(Context::Dialog.priority() < Context::Tui.priority());
    }
}
