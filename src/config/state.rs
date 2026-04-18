//! `state.json` — tool-managed counters and flags the user doesn't
//! hand-edit: onboarding completion, startup count, first-run markers.
//!
//! Why a separate file: see `projects.rs` header. State rewrites on
//! almost every run; co-locating with `settings.json` would mean every
//! launch touches the same file the user might be editing. Split
//! avoids that race.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Error, Result};

use super::paths;

/// `state.json` shape. All fields optional / defaulted so a missing
/// file is equivalent to a zero-initialized `State`.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub onboarding_complete: Option<bool>,
    pub num_startups: u64,
    pub first_startup_date: Option<String>,
    pub last_startup_date: Option<String>,
    /// Unknown keys round-trip.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Read `~/.otherside/state.json`. Missing file → `State::default()`.
pub fn load() -> Result<State> {
    let path = paths::state_path()?;
    if !path.exists() {
        return Ok(State::default());
    }
    let bytes = std::fs::read(&path).map_err(|e| {
        Error::Config(format!("failed to read {}: {e}", path.display()))
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        Error::Config(format!("malformed state in {}: {e}", path.display()))
    })
}

/// Write `~/.otherside/state.json`. §12 upgrades this to atomic.
pub fn save(state: &State) -> Result<()> {
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
        let s: State = serde_json::from_str("{}").unwrap();
        assert_eq!(s, State::default());
        assert_eq!(s.num_startups, 0);
        assert!(s.onboarding_complete.is_none());
    }

    #[test]
    fn unknown_keys_round_trip() {
        let json = r#"{"numStartups":42,"customFlag":true,"nested":{"x":1}}"#;
        let first: State = serde_json::from_str(json).unwrap();
        assert_eq!(first.num_startups, 42);
        assert!(first.extra.contains_key("customFlag"));
        assert!(first.extra.contains_key("nested"));

        let reemitted = serde_json::to_string(&first).unwrap();
        let second: State = serde_json::from_str(&reemitted).unwrap();
        assert_eq!(first, second);
    }
}
