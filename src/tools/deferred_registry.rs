use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};

static REGISTRY: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();

fn registry() -> &'static RwLock<HashSet<String>> {
    REGISTRY.get_or_init(|| RwLock::new(HashSet::new()))
}

pub fn announce(name: &str) {
    if let Ok(mut w) = registry().write() {
        w.insert(name.to_string());
    }
}

pub fn announce_many(names: &[&str]) {
    if let Ok(mut w) = registry().write() {
        for n in names {
            w.insert((*n).to_string());
        }
    }
}

pub fn current() -> Vec<String> {
    registry()
        .read()
        .map(|r| r.iter().cloned().collect())
        .unwrap_or_default()
}

pub fn clear() {
    if let Ok(mut w) = registry().write() {
        w.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn announce_then_current_returns_name() {
        let _g = TEST_LOCK.lock().unwrap();
        clear();
        announce("WebSearch");
        let names = current();
        assert!(names.iter().any(|n| n == "WebSearch"));
        clear();
    }

    #[test]
    fn announce_many_deduplicates() {
        let _g = TEST_LOCK.lock().unwrap();
        clear();
        announce_many(&["WebFetch", "WebFetch", "TaskCreate"]);
        let names = current();
        assert_eq!(names.len(), 2);
        clear();
    }

    #[test]
    fn clear_empties_registry() {
        let _g = TEST_LOCK.lock().unwrap();
        announce("Foo");
        clear();
        assert!(current().is_empty());
    }
}
