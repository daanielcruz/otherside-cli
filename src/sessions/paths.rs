//! Filesystem path layout for sessions.
//!
//! `<config_dir>/sessions/<uuid>/transcript.jsonl`
//!
//! One directory per session lets us evolve the on-disk shape
//! (sidecar summary / state JSON / compacted artifacts) without
//! breaking older sessions — everything stays co-located.

use std::path::{Path, PathBuf};

use super::SessionId;

pub fn sessions_root(config_dir: &Path) -> PathBuf {
    config_dir.join("sessions")
}

pub fn session_dir(config_dir: &Path, id: &SessionId) -> PathBuf {
    sessions_root(config_dir).join(id.to_string())
}

pub fn transcript_path(config_dir: &Path, id: &SessionId) -> PathBuf {
    session_dir(config_dir, id).join("transcript.jsonl")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_root_nests_under_config_dir() {
        let cfg = Path::new("/tmp/example_cfg");
        assert_eq!(sessions_root(cfg), Path::new("/tmp/example_cfg/sessions"));
    }

    #[test]
    fn transcript_path_matches_expected_layout() {
        let cfg = Path::new("/tmp/cfg");
        let id = SessionId::new();
        let path = transcript_path(cfg, &id);
        assert!(path.ends_with("transcript.jsonl"));
        assert!(path.to_string_lossy().contains("sessions"));
    }
}
