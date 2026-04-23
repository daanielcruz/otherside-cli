use crossterm::event::{KeyCode, KeyEvent};

use super::state::{AgentsPanelState, Tab};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOutcome {
    Consumed,
    Dismiss,
}

pub fn handle_key(event: KeyEvent, state: &mut AgentsPanelState) -> KeyOutcome {
    // Detail view intercepts most keys: Esc/Left/Enter back to list, Esc at
    // list dismisses.
    if state.detail.is_some() {
        return match event.code {
            KeyCode::Esc | KeyCode::Left | KeyCode::Enter | KeyCode::Char(' ') => {
                state.back_from_detail();
                KeyOutcome::Consumed
            }
            _ => KeyOutcome::Consumed,
        };
    }
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
                state.enter_library_detail();
            }
            KeyOutcome::Consumed
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

    #[test]
    fn library_enter_opens_detail_view() {
        let mut s = st();
        handle_key(k(KeyCode::Tab), &mut s);
        assert_eq!(s.tab, Tab::Library);
        handle_key(k(KeyCode::Enter), &mut s);
        assert!(s.detail.is_some(), "Library Enter must drill into detail");
    }

    #[test]
    fn detail_esc_returns_to_list_not_dismiss() {
        let mut s = st();
        handle_key(k(KeyCode::Tab), &mut s);
        handle_key(k(KeyCode::Enter), &mut s);
        assert!(s.detail.is_some());
        let outcome = handle_key(k(KeyCode::Esc), &mut s);
        assert_eq!(
            outcome,
            KeyOutcome::Consumed,
            "Esc from detail must NOT dismiss panel — just return to list"
        );
        assert!(s.detail.is_none(), "detail must clear after Esc/Back");
    }

    #[test]
    fn detail_left_also_returns_to_list() {
        let mut s = st();
        handle_key(k(KeyCode::Tab), &mut s);
        handle_key(k(KeyCode::Enter), &mut s);
        handle_key(k(KeyCode::Left), &mut s);
        assert!(s.detail.is_none(), "← must return from detail");
    }

    #[test]
    fn running_enter_does_not_open_library_detail() {
        let mut s = st();
        assert_eq!(s.tab, Tab::Running);
        handle_key(k(KeyCode::Enter), &mut s);
        assert!(s.detail.is_none(), "Running Enter must not open Library detail");
    }
}
