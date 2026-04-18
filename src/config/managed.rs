//! `managed-settings.json` + `managed-settings.d/*.json` loader —
//! operator/admin policy that always wins over user scopes.
//!
//! Why file-based: upstream uses OS-native MDM readers (darwin plist,
//! win HKLM/HKCU) for true enterprise deployment. otherside keeps it
//! JSON-only for portability and reviewability — an ops team drops
//! a file on disk, otherside obeys. No plist parser, no registry
//! reader, no platform-specific code path.
//!
//! Why the drop-in directory: a single monolithic `managed-settings.json`
//! is painful to layer across org/team/project policies. The `.d/`
//! directory convention mirrors systemd/sudoers/logrotate — small
//! files merged in filename order give ops a clean way to compose
//! policy without editing a shared JSON.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::{Error, Result};

use super::{merge, paths};

/// Read the base policy file. Returns `Value::Null` if absent.
pub fn load_base() -> Result<Value> {
    let path = paths::managed_settings_path()?;
    load_base_from(&path)
}

/// Testable variant: read the base from a specific path.
pub fn load_base_from(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(Value::Null);
    }
    let bytes = std::fs::read(path).map_err(|e| {
        Error::Config(format!("failed to read {}: {e}", path.display()))
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        Error::Config(format!("malformed managed-settings in {}: {e}", path.display()))
    })
}

/// Read every `*.json` in the drop-in directory, sorted by filename
/// ascending so `00-org.json` < `10-team.json` < `99-override.json`.
pub fn load_dropins() -> Result<Vec<Value>> {
    let dir = paths::managed_dropin_dir()?;
    load_dropins_from(&dir)
}

/// Testable variant: read drop-ins from a specific directory.
pub fn load_dropins_from(dir: &Path) -> Result<Vec<Value>> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| Error::Config(format!("failed to read {}: {e}", dir.display())))?
        .filter_map(|r| r.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    entries.sort();

    let mut out = Vec::with_capacity(entries.len());
    for p in entries {
        let bytes = std::fs::read(&p).map_err(|e| {
            Error::Config(format!("failed to read {}: {e}", p.display()))
        })?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|e| {
            Error::Config(format!("malformed dropin {}: {e}", p.display()))
        })?;
        out.push(v);
    }
    Ok(out)
}

/// Collapse base + drop-ins into one effective policy Value ready to
/// be fed to the five-scope resolver as `SettingsSource::Policy`.
pub fn load_effective() -> Result<Value> {
    let base = match load_base()? {
        Value::Null => Value::Object(Map::new()),
        other => other,
    };
    let dropins = load_dropins()?;
    Ok(merge::deep_merge_chain(base, dropins))
}

/// Testable variant: collapse from explicit base path + dropin dir.
pub fn load_effective_from(base_path: &Path, dropin_dir: &Path) -> Result<Value> {
    let base = match load_base_from(base_path)? {
        Value::Null => Value::Object(Map::new()),
        other => other,
    };
    let dropins = load_dropins_from(dropin_dir)?;
    Ok(merge::deep_merge_chain(base, dropins))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn corpus_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config_corpus")
    }

    #[test]
    fn corpus_base_parses() {
        let base = load_base_from(&corpus_root().join("managed/base.json")).unwrap();
        let obj = base.as_object().expect("object at top level");
        assert_eq!(obj.get("strictPluginOnlyCustomization"), Some(&json!(true)));
        assert_eq!(obj.get("allowManagedHooksOnly"), Some(&json!(true)));
        let allowed = obj.get("allowedMcpServers").unwrap().as_array().unwrap();
        assert_eq!(allowed.len(), 2);
    }

    #[test]
    fn missing_base_returns_null() {
        let v = load_base_from(Path::new("/definitely/not/a/real/path.json")).unwrap();
        assert!(v.is_null());
    }

    #[test]
    fn dropins_loaded_in_filename_order() {
        let dir = corpus_root().join("managed/base_plus_dropins/managed-settings.d");
        let dropins = load_dropins_from(&dir).unwrap();
        assert_eq!(dropins.len(), 2);

        // first is 00-org.json (allowManagedHooksOnly=false)
        let first = dropins[0].as_object().unwrap();
        assert_eq!(first.get("allowManagedHooksOnly"), Some(&json!(false)));

        // second is 10-team.json (allowManagedHooksOnly=true)
        let second = dropins[1].as_object().unwrap();
        assert_eq!(second.get("allowManagedHooksOnly"), Some(&json!(true)));
    }

    #[test]
    fn missing_dropin_dir_yields_empty_list() {
        let dropins = load_dropins_from(Path::new("/definitely/not/a/real/dir")).unwrap();
        assert!(dropins.is_empty());
    }

    #[test]
    fn base_plus_dropins_ten_wins_on_conflict() {
        let base_path = corpus_root().join("managed/base_plus_dropins/managed-settings.json");
        let dropin_dir = corpus_root().join("managed/base_plus_dropins/managed-settings.d");
        let effective = load_effective_from(&base_path, &dropin_dir).unwrap();
        let obj = effective.as_object().unwrap();

        // 10-team.json sets allowManagedHooksOnly=true (overrides 00-org's false)
        assert_eq!(obj.get("allowManagedHooksOnly"), Some(&json!(true)));

        // allowedMcpServers: base absent, 00-org sets ["filesystem"],
        // 10-team sets ["filesystem","git","team-internal-mcp"] —
        // arrays concat + dedupe so the final list has all three.
        let allowed = obj.get("allowedMcpServers").unwrap().as_array().unwrap();
        let names: Vec<&str> = allowed.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.contains(&"filesystem"));
        assert!(names.contains(&"git"));
        assert!(names.contains(&"team-internal-mcp"));

        // permissions.deny: base has one, each dropin adds one, all three survive.
        let deny = effective
            .pointer("/permissions/deny")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(deny.len(), 3);
    }
}
