//! Session-scoped set of paths the user has Read in this conversation.
//!
//! The Edit tool requires a matching Read to have happened first —
//! that's the upstream invariant. It's a safety net against the model
//! hallucinating file contents and Edit'ing the wrong surface.
//!
//! Scope: one per session. The agent loop owns the instance; tests
//! construct their own to avoid cross-talk.

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

    /// Mark `path` as read. Canonicalizes first so symlinks /
    /// relative paths resolve to the same entry.
    pub fn insert(&self, path: &Path) {
        let key = canonicalize(path);
        self.inner.lock().unwrap().insert(key);
    }

    /// Was `path` read earlier in this session?
    pub fn contains(&self, path: &Path) -> bool {
        let key = canonicalize(path);
        self.inner.lock().unwrap().contains(&key)
    }

    pub fn clear(&self) {
        self.inner.lock().unwrap().clear();
    }
}

/// Process-wide default. The TUI event loop uses this so sibling
/// Read / Edit dispatches route through the same set without
/// plumbing a ctx struct through every call.
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
