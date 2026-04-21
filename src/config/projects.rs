

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Error, Result};

use super::paths;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectsConfig {

    pub projects: HashMap<String, ProjectEntry>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectEntry {
    pub trusted: bool,

    pub last_accessed: Option<String>,
    pub history: Vec<HistoryEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub prompt: String,
    pub ts: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

pub fn load() -> Result<ProjectsConfig> {
    let path = paths::projects_path()?;
    if !path.exists() {
        return Ok(ProjectsConfig::default());
    }
    let bytes = std::fs::read(&path).map_err(|e| {
        Error::Config(format!("failed to read {}: {e}", path.display()))
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        Error::Config(format!("malformed projects in {}: {e}", path.display()))
    })
}

pub fn save(cfg: &ProjectsConfig) -> Result<()> {
    let path = paths::projects_path()?;
    let bytes = serde_json::to_vec_pretty(cfg).map_err(|e| {
        Error::Config(format!("failed to serialize projects: {e}"))
    })?;
    super::write_atomic(&path, &bytes, false)
}

pub fn is_trusted(cfg: &ProjectsConfig, workspace: &Path) -> bool {
    cfg.projects
        .get(&workspace.to_string_lossy().into_owned())
        .is_some_and(|entry| entry.trusted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn corpus_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config_corpus")
    }

    #[test]
    fn corpus_empty_parses() {
        let bytes = std::fs::read(corpus_root().join("projects/empty.json")).unwrap();
        let cfg: ProjectsConfig = serde_json::from_slice(&bytes).unwrap();
        assert!(cfg.projects.is_empty());
    }

    #[test]
    fn corpus_with_trust_parses() {
        let bytes = std::fs::read(corpus_root().join("projects/with_trust.json")).unwrap();
        let cfg: ProjectsConfig = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(cfg.projects.len(), 3);

        let trusted = cfg
            .projects
            .get("/Users/example/Desktop/otherside")
            .unwrap();
        assert!(trusted.trusted);
        assert_eq!(trusted.history.len(), 2);
        assert_eq!(trusted.last_accessed.as_deref(), Some("2026-04-18T12:34:56Z"));

        let untrusted = cfg
            .projects
            .get("/tmp/one-off")
            .unwrap();
        assert!(!untrusted.trusted);
        assert!(untrusted.last_accessed.is_none());
        assert!(untrusted.history.is_empty());
    }

    #[test]
    fn is_trusted_helper_matches_by_path() {
        let bytes = std::fs::read(corpus_root().join("projects/with_trust.json")).unwrap();
        let cfg: ProjectsConfig = serde_json::from_slice(&bytes).unwrap();

        assert!(is_trusted(&cfg, Path::new("/Users/example/Desktop/otherside")));
        assert!(!is_trusted(&cfg, Path::new("/Users/example/Desktop/scratch")));
        assert!(!is_trusted(&cfg, Path::new("/does/not/exist")));
    }

    #[test]
    fn round_trip_preserves_unknown_keys() {
        let bytes = std::fs::read(corpus_root().join("projects/with_trust.json")).unwrap();
        let first: ProjectsConfig = serde_json::from_slice(&bytes).unwrap();
        let reemitted = serde_json::to_vec(&first).unwrap();
        let second: ProjectsConfig = serde_json::from_slice(&reemitted).unwrap();
        assert_eq!(first, second);
    }
}
