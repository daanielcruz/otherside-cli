use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tokio::sync::watch;

fn registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(tool_call_id: &str) -> watch::Receiver<bool> {
    let (tx, rx) = watch::channel(false);
    registry()
        .lock()
        .expect("background_signal registry poisoned")
        .insert(tool_call_id.to_string(), tx);
    rx
}

pub fn unregister(tool_call_id: &str) {
    registry()
        .lock()
        .expect("background_signal registry poisoned")
        .remove(tool_call_id);
}

pub fn signal_all() -> Vec<String> {
    let mut map = registry()
        .lock()
        .expect("background_signal registry poisoned");
    let ids: Vec<String> = map.keys().cloned().collect();
    for (_, tx) in map.drain() {
        let _: std::result::Result<(), watch::error::SendError<bool>> = tx.send(true);
    }
    ids
}

/// Signal a single tool_call_id. Returns `true` when a receiver was
/// registered and notified; `false` when nothing matched (already
/// unregistered / spurious id). Used by `/tasks` detail `x` to kill one
/// specific task without affecting siblings.
pub fn signal(tool_call_id: &str) -> bool {
    let mut map = registry()
        .lock()
        .expect("background_signal registry poisoned");
    if let Some(tx) = map.remove(tool_call_id) {
        let _: std::result::Result<(), watch::error::SendError<bool>> = tx.send(true);
        true
    } else {
        false
    }
}

pub fn is_registered(tool_call_id: &str) -> bool {
    registry()
        .lock()
        .expect("background_signal registry poisoned")
        .contains_key(tool_call_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_returns_receiver_that_sees_signal() {
        let id = format!("test_{}", uuid::Uuid::new_v4());
        let mut rx = register(&id);
        assert_eq!(*rx.borrow(), false);
        let flipped = signal_all();
        assert!(flipped.iter().any(|s| s == &id));
        assert_eq!(*rx.borrow_and_update(), true);
    }

    #[test]
    fn unregister_removes_from_registry() {
        let id = format!("test_{}", uuid::Uuid::new_v4());
        let _rx = register(&id);
        assert!(is_registered(&id));
        unregister(&id);
        assert!(!is_registered(&id));
    }

    #[test]
    fn signal_all_drains_and_returns_ids() {
        let id_a = format!("a_{}", uuid::Uuid::new_v4());
        let id_b = format!("b_{}", uuid::Uuid::new_v4());
        let _ra = register(&id_a);
        let _rb = register(&id_b);
        let flipped = signal_all();
        assert!(flipped.contains(&id_a));
        assert!(flipped.contains(&id_b));
        assert!(!is_registered(&id_a));
        assert!(!is_registered(&id_b));
    }
}
