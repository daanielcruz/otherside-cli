

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone, Default)]
pub struct ReadSet {
    inner: Arc<Mutex<HashSet<PathBuf>>>,
}

impl ReadSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, path: &Path) {
        let key = canonicalize(path);
        self.inner.lock().unwrap().insert(key);
    }

    pub fn contains(&self, path: &Path) -> bool {
        let key = canonicalize(path);
        self.inner.lock().unwrap().contains(&key)
    }

    pub fn clear(&self) {
        self.inner.lock().unwrap().clear();
    }
}

pub fn global() -> &'static ReadSet {
    static GLOBAL: OnceLock<ReadSet> = OnceLock::new();
    GLOBAL.get_or_init(ReadSet::new)
}

fn canonicalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_contains_round_trip() {
        let set = ReadSet::new();
        let path = std::env::temp_dir().join("otherside_read_set_probe");
        std::fs::write(&path, b"probe").unwrap();
        set.insert(&path);
        assert!(set.contains(&path));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn clear_empties_the_set() {
        let set = ReadSet::new();
        let path = PathBuf::from("/tmp/does_not_exist_xyz");
        set.insert(&path);
        assert!(set.contains(&path));
        set.clear();
        assert!(!set.contains(&path));
    }
}
