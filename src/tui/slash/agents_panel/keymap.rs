use crossterm::event::{KeyCode, KeyEvent};

use super::state::{AgentsPanelState, Tab};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOutcome {
    Consumed,
    Dismiss,
}

pub fn handle_key(event: KeyEvent, state: &mut AgentsPanelState) -> KeyOutcome {
    match event.code {
        KeyCode::Esc => KeyOutcome::Dismiss,
        KeyCode::Tab | KeyCode::Right | KeyCode::Left | KeyCode::BackTab => {
            state.cycle_tab();
            KeyOutcome::Consumed
        }
        KeyCode::Up => {
            state.cursor_up();
            KeyOutcome::Consumed
        }
        KeyCode::Down => {
            state.cursor_down();
            KeyOutcome::Consumed
        }
        KeyCode::Enter => {
            if matches!(state.tab, Tab::Library) {
                KeyOutcome::Consumed
            } else {
                KeyOutcome::Consumed
            }
        }
        _ => KeyOutcome::Consumed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::subagents::registry;
    use crate::tasks::TaskStore;
    use crossterm::event::KeyModifiers;

    fn st() -> AgentsPanelState {
        AgentsPanelState::new(&TaskStore::new(), registry::all())
    }

    fn k(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn esc_dismisses() {
        let mut s = st();
        assert_eq!(handle_key(k(KeyCode::Esc), &mut s), KeyOutcome::Dismiss);
    }

    #[test]
    fn tab_cycles_tabs() {
        let mut s = st();
        assert_eq!(s.tab, Tab::Running);
        assert_eq!(handle_key(k(KeyCode::Tab), &mut s), KeyOutcome::Consumed);
        assert_eq!(s.tab, Tab::Library);
    }

    #[test]
    fn left_right_also_cycle_tabs() {
        let mut s = st();
        handle_key(k(KeyCode::Right), &mut s);
        assert_eq!(s.tab, Tab::Library);
        handle_key(k(KeyCode::Left), &mut s);
        assert_eq!(s.tab, Tab::Running);
    }
}
