use crossterm::event::{KeyCode, KeyEvent};

use super::state::{Mode, TasksPanelState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOutcome {
    Consumed,
    Dismiss,
    
    StopFocused,
}

pub fn handle_key(event: KeyEvent, state: &mut TasksPanelState) -> KeyOutcome {
    match state.mode {
        Mode::List => handle_list_key(event, state),
        Mode::Detail(_) => handle_detail_key(event, state),
    }
}

fn handle_list_key(event: KeyEvent, state: &mut TasksPanelState) -> KeyOutcome {
    match event.code {
        KeyCode::Esc | KeyCode::Left => KeyOutcome::Dismiss,
        KeyCode::Up => {
            state.cursor_up();
            KeyOutcome::Consumed
        }
        KeyCode::Down => {
            state.cursor_down();
            KeyOutcome::Consumed
        }
        KeyCode::Enter | KeyCode::Right => {
            state.enter_detail();
            KeyOutcome::Consumed
        }
        _ => KeyOutcome::Consumed,
    }
}

fn handle_detail_key(event: KeyEvent, state: &mut TasksPanelState) -> KeyOutcome {
    match event.code {
        
        KeyCode::Left => {
            if state.rows.len() <= 1 {
                KeyOutcome::Dismiss
            } else if state.back_to_list() {
                KeyOutcome::Consumed
            } else {
                KeyOutcome::Dismiss
            }
        }
        KeyCode::Esc | KeyCode::Enter | KeyCode::Char(' ') => KeyOutcome::Dismiss,
        KeyCode::Char('x') => KeyOutcome::StopFocused,
        _ => KeyOutcome::Consumed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{TaskId, TaskRecord, TaskStore};
    use crossterm::event::KeyModifiers;

    fn k(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn store_with_two() -> TaskStore {
        let s = TaskStore::new();
        for name in ["a", "b"] {
            let mut r = TaskRecord::new_agent(
                TaskId::generate(),
                name.into(),
                "p".into(),
            );
            r.subagent_type = Some(name.into());
            s.insert(r);
        }
        s
    }

    #[test]
    fn list_esc_dismisses() {
        let store = store_with_two();
        let mut s = TasksPanelState::new(&store);
        assert_eq!(handle_key(k(KeyCode::Esc), &mut s), KeyOutcome::Dismiss);
    }

    #[test]
    fn list_left_arrow_dismisses() {
        let store = store_with_two();
        let mut s = TasksPanelState::new(&store);
        assert_eq!(
            handle_key(k(KeyCode::Left), &mut s),
            KeyOutcome::Dismiss,
            "footer hint advertises ←/Esc close — ← must dismiss list"
        );
    }

    #[test]
    fn list_enter_drills_to_detail() {
        let store = store_with_two();
        let mut s = TasksPanelState::new(&store);
        handle_key(k(KeyCode::Enter), &mut s);
        assert!(matches!(s.mode, Mode::Detail(_)));
    }

    #[test]
    fn detail_left_returns_to_list_when_multiple() {
        let store = store_with_two();
        let mut s = TasksPanelState::new(&store);
        handle_key(k(KeyCode::Enter), &mut s);
        assert_eq!(handle_key(k(KeyCode::Left), &mut s), KeyOutcome::Consumed);
        assert!(matches!(s.mode, Mode::List));
    }

    #[test]
    fn detail_left_dismisses_when_single_task_auto_skipped() {
        let store = TaskStore::new();
        let mut r = TaskRecord::new_agent(
            TaskId::generate(),
            "solo".into(),
            "p".into(),
        );
        r.subagent_type = Some("solo".into());
        store.insert(r);
        let mut s = TasksPanelState::new(&store);
        assert!(matches!(s.mode, Mode::Detail(0)));
        assert_eq!(
            handle_key(k(KeyCode::Left), &mut s),
            KeyOutcome::Dismiss,
            "single-task auto-skip has no list to return to — ← must dismiss",
        );
    }

    #[test]
    fn detail_space_and_enter_dismiss() {
        let store = store_with_two();
        let mut s = TasksPanelState::new(&store);
        handle_key(k(KeyCode::Enter), &mut s); 
        assert_eq!(handle_key(k(KeyCode::Char(' ')), &mut s), KeyOutcome::Dismiss);
    }

    #[test]
    fn detail_x_requests_stop() {
        let store = store_with_two();
        let mut s = TasksPanelState::new(&store);
        handle_key(k(KeyCode::Enter), &mut s);
        assert_eq!(
            handle_key(k(KeyCode::Char('x')), &mut s),
            KeyOutcome::StopFocused,
        );
    }
}
