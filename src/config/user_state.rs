//! `state.json` — tool-managed counters the user doesn't hand-edit:
//! onboarding completion, startup count, first-run markers.
//!
//! Renamed from `config::state::State` to disambiguate from
//! `crate::state::Session` (runtime identity — model / effort /
//! permission_mode) and `crate::sessions::` (transcript JSONL writer).
//! Every field here is process-startup bookkeeping, never session
//! runtime state.
//!
//! Why a separate file from `settings.json`: see `projects.rs` header.
//! State rewrites on almost every run; co-locating with `settings.json`
//! would mean every launch touches the same file the user might be
//! editing. Split avoids that race.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Error, Result};

use super::paths;

/// `state.json` shape. All fields optional / defaulted so a missing
/// file is equivalent to a zero-initialized `StartupCounters`.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct StartupCounters {
    pub onboarding_complete: Option<bool>,
    pub num_startups: u64,
    pub first_startup_date: Option<String>,
    pub last_startup_date: Option<String>,
    /// Unknown keys round-trip.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Read `~/.otherside/state.json`. Missing file →
/// `StartupCounters::default()`.
pub fn load() -> Result<StartupCounters> {
    let path = paths::state_path()?;
    if !path.exists() {
        return Ok(StartupCounters::default());
    }
    let bytes = std::fs::read(&path).map_err(|e| {
        Error::Config(format!("failed to read {}: {e}", path.display()))
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        Error::Config(format!("malformed state in {}: {e}", path.display()))
    })
}

/// Write `~/.otherside/state.json`. §12 upgrades this to atomic.
pub fn save(state: &StartupCounters) -> Result<()> {
    let path = paths::state_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Error::Config(format!(
                "failed to create {}: {e}",
                parent.display()
            ))
        })?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| {
        Error::Config(format!("failed to serialize state: {e}"))
    })?;
    std::fs::write(&path, bytes).map_err(|e| {
        Error::Config(format!("failed to write {}: {e}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_default() {
        let s: StartupCounters = serde_json::from_str("{}").unwrap();
        assert_eq!(s, StartupCounters::default());
        assert_eq!(s.num_startups, 0);
        assert!(s.onboarding_complete.is_none());
    }

    #[test]
    fn unknown_keys_round_trip() {
        let json = r#"{"numStartups":42,"customFlag":true,"nested":{"x":1}}"#;
        let first: StartupCounters = serde_json::from_str(json).unwrap();
        assert_eq!(first.num_startups, 42);
        assert!(first.extra.contains_key("customFlag"));
        assert!(first.extra.contains_key("nested"));

        let reemitted = serde_json::to_string(&first).unwrap();
        let second: StartupCounters = serde_json::from_str(&reemitted).unwrap();
        assert_eq!(first, second);
    }
}
