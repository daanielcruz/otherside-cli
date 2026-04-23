
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

    pub last_session_id: Option<String>,

    pub last_provider: Option<String>,
    pub last_model: Option<String>,

    pub last_total_input_tokens: Option<u64>,
    pub last_total_output_tokens: Option<u64>,

    pub last_model_usage: HashMap<String, ModelUsage>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub turns: u64,
    pub last_used_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ModelUsage {
    pub fn record_turn(&mut self, input: u64, output: u64, ts: String) {
        self.input_tokens = self.input_tokens.saturating_add(input);
        self.output_tokens = self.output_tokens.saturating_add(output);
        self.turns = self.turns.saturating_add(1);
        self.last_used_at = Some(ts);
    }
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

pub fn record_turn_usage(
    workspace: &Path,
    provider_slug: &str,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    session_id: Option<String>,
    ts: String,
) -> Result<()> {
    if input_tokens == 0 && output_tokens == 0 {
        return Ok(());
    }

    let mut cfg = load().unwrap_or_default();
    let key = workspace.to_string_lossy().into_owned();
    let entry = cfg.projects.entry(key).or_default();
    entry.last_accessed = Some(ts.clone());
    entry.last_provider = Some(provider_slug.to_string());
    entry.last_model = Some(model.to_string());
    entry.last_total_input_tokens = Some(input_tokens);
    entry.last_total_output_tokens = Some(output_tokens);
    if let Some(sid) = session_id {
        entry.last_session_id = Some(sid);
    }
    let usage_key = format!("{provider_slug}:{model}");
    entry
        .last_model_usage
        .entry(usage_key)
        .or_default()
        .record_turn(input_tokens, output_tokens, ts);

    save(&cfg)
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

    #[test]
    fn model_usage_accumulates_across_turns() {
        let mut usage = ModelUsage::default();
        usage.record_turn(100, 20, "2026-04-22T10:00:00Z".into());
        usage.record_turn(250, 45, "2026-04-22T10:05:00Z".into());
        assert_eq!(usage.input_tokens, 350);
        assert_eq!(usage.output_tokens, 65);
        assert_eq!(usage.turns, 2);
        assert_eq!(usage.last_used_at.as_deref(), Some("2026-04-22T10:05:00Z"));
    }

    #[test]
    fn model_usage_round_trips_via_json() {
        let mut usage = ModelUsage::default();
        usage.record_turn(123, 45, "2026-04-22T10:00:00Z".into());
        let json = serde_json::to_string(&usage).unwrap();
        let back: ModelUsage = serde_json::from_str(&json).unwrap();
        assert_eq!(back, usage);
        
        assert!(json.contains("\"inputTokens\""));
        assert!(json.contains("\"outputTokens\""));
        assert!(json.contains("\"lastUsedAt\""));
    }

    #[test]
    fn project_entry_defaults_carry_empty_usage_map() {
        let entry = ProjectEntry::default();
        assert!(entry.last_model_usage.is_empty());
        assert!(entry.last_session_id.is_none());
        assert_eq!(entry.last_total_input_tokens, None);
    }
}
