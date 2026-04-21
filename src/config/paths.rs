

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::Result;

use super::{config_dir, settings_path};

const PROJECT_DIR: &str = ".otherside";

const PROJECT_SETTINGS: &str = "settings.json";

const MCP_JSON: &str = ".mcp.json";

const MANAGED_SETTINGS: &str = "managed-settings.json";

const MANAGED_DROPIN_DIR: &str = "managed-settings.d";

const SHADOW_ENV_VARS: &[&str] = &[
    "OTHERSIDE_PROVIDER",
    "OTHERSIDE_MODEL",
    "OTHERSIDE_LOG_LEVEL",
    "OTHERSIDE_PERMISSION_MODE",
    "OTHERSIDE_OPENAI_COMPATIBLE_BASE_URL",
    "OTHERSIDE_OPENAI_COMPATIBLE_API_KEY",
    "OTHERSIDE_DEFAULT_PROVIDER",
    "OTHERSIDE_DEFAULT_MODEL",
];

pub fn user_settings_path() -> Result<PathBuf> {
    settings_path()
}

pub fn projects_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("projects.json"))
}

pub fn state_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("state.json"))
}

pub fn managed_settings_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(MANAGED_SETTINGS))
}

pub fn managed_dropin_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join(MANAGED_DROPIN_DIR))
}

pub fn project_settings_path(cwd: &Path) -> Option<PathBuf> {
    for ancestor in cwd.ancestors() {
        let candidate = ancestor.join(PROJECT_DIR).join(PROJECT_SETTINGS);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn mcp_json_chain(cwd: &Path) -> Vec<PathBuf> {
    let mut hits: Vec<PathBuf> = cwd
        .ancestors()
        .filter_map(|a| {
            let candidate = a.join(MCP_JSON);
            candidate.is_file().then_some(candidate)
        })
        .collect();

    hits.reverse();
    hits
}

pub fn warn_shadow_env_vars() {
    static WARNED: OnceLock<()> = OnceLock::new();
    if WARNED.get().is_some() {
        return;
    }
    let hits: Vec<&str> = SHADOW_ENV_VARS
        .iter()
        .copied()
        .filter(|k| std::env::var_os(k).is_some())
        .collect();
    if !hits.is_empty() {
        tracing::warn!(
            shadow_env_vars = ?hits,
            "config is file-only; these env vars are ignored. \
             Edit ~/.otherside/settings.json or the project-local overlay instead. \
             Only OTHERSIDE_CONFIG_DIR relocates the config home."
        );
    }
    let _ = WARNED.set(());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn new(vars: &[&'static str]) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let saved = vars.iter().map(|&k| (k, std::env::var(k).ok())).collect();
            for &k in vars {
                unsafe { std::env::remove_var(k) };
            }
            Self { saved, _lock: lock }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in self.saved.drain(..) {
                unsafe {
                    match v {
                        Some(val) => std::env::set_var(k, val),
                        None => std::env::remove_var(k),
                    }
                }
            }
        }
    }

    #[test]
    fn config_dir_override_redirects_all_paths() {
        let _g = EnvGuard::new(&["OTHERSIDE_CONFIG_DIR"]);
        unsafe {
            std::env::set_var("OTHERSIDE_CONFIG_DIR", "/tmp/otherside-path-test");
        }
        assert_eq!(
            user_settings_path().unwrap(),
            PathBuf::from("/tmp/otherside-path-test/settings.json")
        );
        assert_eq!(
            projects_path().unwrap(),
            PathBuf::from("/tmp/otherside-path-test/projects.json")
        );
        assert_eq!(
            state_path().unwrap(),
            PathBuf::from("/tmp/otherside-path-test/state.json")
        );
        assert_eq!(
            managed_settings_path().unwrap(),
            PathBuf::from("/tmp/otherside-path-test/managed-settings.json")
        );
        assert_eq!(
            managed_dropin_dir().unwrap(),
            PathBuf::from("/tmp/otherside-path-test/managed-settings.d")
        );
    }

    #[test]
    fn project_settings_walk_finds_nearest() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-projwalk-{}",
            std::process::id()
        ));
        let root = tmp.join("root");
        let sub = root.join("sub").join("deep");
        fs::create_dir_all(sub.join(PROJECT_DIR)).unwrap();
        fs::create_dir_all(root.join(PROJECT_DIR)).unwrap();
        fs::write(root.join(PROJECT_DIR).join(PROJECT_SETTINGS), "{}").unwrap();
        fs::write(sub.join(PROJECT_DIR).join(PROJECT_SETTINGS), "{}").unwrap();

        let found = project_settings_path(&sub).unwrap();
        assert_eq!(found, sub.join(PROJECT_DIR).join(PROJECT_SETTINGS));

        let found = project_settings_path(&root).unwrap();
        assert_eq!(found, root.join(PROJECT_DIR).join(PROJECT_SETTINGS));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn project_settings_walk_returns_none_when_absent() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-projwalk-miss-{}",
            std::process::id()
        ));
        fs::create_dir_all(&tmp).unwrap();
        assert!(project_settings_path(&tmp).is_none());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn mcp_json_chain_collects_base_to_overlay() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-mcpwalk-{}",
            std::process::id()
        ));
        let root = tmp.join("root");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(root.join(MCP_JSON), r#"{"mcpServers":{}}"#).unwrap();
        fs::write(sub.join(MCP_JSON), r#"{"mcpServers":{}}"#).unwrap();

        let chain = mcp_json_chain(&sub);

        assert_eq!(chain.first().unwrap(), &root.join(MCP_JSON));
        assert_eq!(chain.last().unwrap(), &sub.join(MCP_JSON));
        assert_eq!(chain.len(), 2);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn mcp_json_chain_empty_when_none_present() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-mcpwalk-miss-{}",
            std::process::id()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let chain = mcp_json_chain(&tmp);
        assert!(chain.is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn shadow_env_vars_covers_expected_names() {

        assert!(SHADOW_ENV_VARS.contains(&"OTHERSIDE_PROVIDER"));
        assert!(SHADOW_ENV_VARS.contains(&"OTHERSIDE_MODEL"));
        assert!(SHADOW_ENV_VARS.contains(&"OTHERSIDE_PERMISSION_MODE"));
        assert!(!SHADOW_ENV_VARS.contains(&"OTHERSIDE_CONFIG_DIR"));
    }
}
