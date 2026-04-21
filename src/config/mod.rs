

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde_json::{Map, Value};

use crate::error::{Error, Result};

pub mod managed;
pub mod mcp;
pub mod merge;
pub mod paths;
pub mod projects;
pub mod providers;
pub mod settings;
pub mod user_state;
pub mod validation;

pub use settings::{
    AnthropicOauthSettings, CodexSettings, GeminiCliSettings, HookEntry, HooksConfig,
    OpenAiCompatibleSettings, PermissionMode, PermissionRule, PermissionsConfig,
    ProviderSettings, Settings,
};
pub use validation::{Scope, ValidationWarning, WarningKind};

const SETTINGS_FILENAME: &str = "settings.json";

const CREDENTIALS_FILENAME: &str = "credentials.json";

pub fn config_dir() -> Result<PathBuf> {
    if let Some(override_dir) = std::env::var_os("OTHERSIDE_CONFIG_DIR") {
        return Ok(PathBuf::from(override_dir));
    }

    let base = directories::BaseDirs::new().ok_or_else(|| {
        Error::Config("could not determine home directory".to_string())
    })?;
    Ok(base.home_dir().join(".otherside"))
}

pub fn settings_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(SETTINGS_FILENAME))
}

pub fn credentials_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(CREDENTIALS_FILENAME))
}

#[derive(Debug, Clone, PartialEq)]
pub enum SettingsSource {
    UserGlobal(Value),
    ProjectLocal(Value),
    Flag(Value),
    Policy(Value),
}

#[derive(Debug, Default, Clone)]
pub struct EffectiveConfig {
    pub settings: Settings,
    pub projects: projects::ProjectsConfig,
    pub state: user_state::StartupCounters,
    pub mcp: mcp::McpJsonConfig,
    pub warnings: Vec<ValidationWarning>,
}

pub fn resolve(sources: &[SettingsSource]) -> (Settings, Vec<ValidationWarning>) {
    let empty = || Value::Object(Map::new());
    let mut user = empty();
    let mut project = empty();
    let mut flag = empty();
    let mut policy = empty();

    for s in sources {
        match s {
            SettingsSource::UserGlobal(v) => user = v.clone(),
            SettingsSource::ProjectLocal(v) => project = v.clone(),
            SettingsSource::Flag(v) => flag = v.clone(),
            SettingsSource::Policy(v) => policy = v.clone(),
        }
    }

    let merged = merge::deep_merge(user, project);
    let merged = merge::deep_merge(merged, flag);
    let merged = merge::deep_merge(merged, policy);

    let mut warnings = Vec::new();
    let mut settings: Settings = match serde_json::from_value(merged.clone()) {
        Ok(s) => s,
        Err(_) => {

            warnings.push(ValidationWarning::new(
                Scope::UserGlobal,
                WarningKind::UnknownTopLevelKey,
                "merged config produced non-Settings shape; using defaults".to_string(),
            ));
            Settings::default()
        }
    };

    for (k, _) in &settings.extra {
        warnings.push(ValidationWarning::new(
            Scope::UserGlobal,
            WarningKind::UnknownTopLevelKey,
            k.clone(),
        ));
    }

    if let Some(perms) = settings.permissions.as_mut() {
        prune_invalid(&mut perms.allow, "permissions.allow", &mut warnings);
        prune_invalid(&mut perms.deny, "permissions.deny", &mut warnings);
        prune_invalid(&mut perms.ask, "permissions.ask", &mut warnings);
    }

    (settings, warnings)
}

fn prune_invalid(
    rules: &mut Vec<PermissionRule>,
    lane: &str,
    warnings: &mut Vec<ValidationWarning>,
) {
    let mut i = 0;
    while i < rules.len() {
        if !rules[i].is_valid() {
            let dropped = rules.remove(i);
            warnings.push(ValidationWarning::new(
                Scope::UserGlobal,
                WarningKind::InvalidPermissionRule,
                format!("{lane}: dropped rule missing required field: {dropped:?}"),
            ));
        } else {
            i += 1;
        }
    }
}

static CACHE: RwLock<Option<EffectiveConfig>> = RwLock::new(None);

pub fn load_all(cwd: &Path, cli_flags: Value) -> Result<EffectiveConfig> {
    if let Some(cached) = CACHE.read().ok().and_then(|g| g.clone()) {
        return Ok(cached);
    }

    paths::warn_shadow_env_vars();

    let user_value = read_json_or_empty(&settings_path()?)?;
    let project_value = match paths::project_settings_path(cwd) {
        Some(p) => read_json_or_empty(&p)?,
        None => Value::Object(Map::new()),
    };
    let policy_value = managed::load_effective()?;

    let sources = [
        SettingsSource::UserGlobal(user_value),
        SettingsSource::ProjectLocal(project_value),
        SettingsSource::Flag(cli_flags),
        SettingsSource::Policy(policy_value),
    ];

    let (settings, warnings) = resolve(&sources);
    let projects = projects::load().unwrap_or_default();
    let state = user_state::load().unwrap_or_default();
    let mcp = mcp::load_effective(cwd).unwrap_or_default();

    let effective = EffectiveConfig {
        settings,
        projects,
        state,
        mcp,
        warnings,
    };
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(effective.clone());
    }
    Ok(effective)
}

pub fn reset_cache() {
    if let Ok(mut guard) = CACHE.write() {
        *guard = None;
    }
}

fn read_json_or_empty(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let bytes = std::fs::read(path).map_err(|e| {
        Error::Config(format!("failed to read {}: {e}", path.display()))
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        Error::Config(format!("malformed settings in {}: {e}", path.display()))
    })
}

pub fn load() -> Result<Settings> {
    let path = settings_path()?;
    load_from(&path)
}

pub fn load_from(path: &Path) -> Result<Settings> {
    paths::warn_shadow_env_vars();

    if !path.exists() {
        return Ok(Settings::default());
    }

    let bytes = std::fs::read(path).map_err(|e| {
        Error::Config(format!("failed to read {}: {e}", path.display()))
    })?;
    serde_json::from_slice::<Settings>(&bytes).map_err(|e| {
        Error::Config(format!("malformed settings in {}: {e}", path.display()))
    })
}

pub fn write_atomic(path: &Path, bytes: &[u8], mode_0600: bool) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Error::Config(format!("failed to create {}: {e}", parent.display()))
        })?;
    }

    let tmp = tmp_sibling(path);
    {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| Error::Config(format!("failed to open {}: {e}", tmp.display())))?;

        use std::io::Write;
        file.write_all(bytes)
            .map_err(|e| Error::Config(format!("failed to write {}: {e}", tmp.display())))?;
        file.sync_all()
            .map_err(|e| Error::Config(format!("failed to fsync {}: {e}", tmp.display())))?;
    }

    #[cfg(unix)]
    if mode_0600 {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&tmp, perms).map_err(|e| {
            Error::Config(format!("failed to chmod {}: {e}", tmp.display()))
        })?;
    }
    #[cfg(not(unix))]
    let _ = mode_0600;

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        Error::Config(format!(
            "failed to rename {} → {}: {e}",
            tmp.display(),
            path.display()
        ))
    })
}

fn tmp_sibling(path: &Path) -> PathBuf {
    let mut buf = path.to_path_buf();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    buf.set_file_name(format!(".{name}.tmp.{}", std::process::id()));
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
            let saved = vars
                .iter()
                .map(|&k| (k, std::env::var(k).ok()))
                .collect::<Vec<_>>();
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
    fn missing_file_yields_defaults() {
        let _g = EnvGuard::new(&["OTHERSIDE_CONFIG_DIR"]);
        let tmp = std::env::temp_dir().join("otherside-test-missing");
        let _ = fs::remove_dir_all(&tmp);
        unsafe { std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp) };
        let settings = load().unwrap();
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn parses_minimal_settings_file() {
        let _g = EnvGuard::new(&[]);
        let tmp = std::env::temp_dir().join("otherside-test-parse.json");
        fs::write(
            &tmp,
            r#"{"defaultProvider":"anthropic-oauth","defaultModel":"claude-opus-4-7"}"#,
        )
        .unwrap();
        let settings = load_from(&tmp).unwrap();
        assert_eq!(settings.default_provider.as_deref(), Some("anthropic-oauth"));
        assert_eq!(settings.default_model.as_deref(), Some("claude-opus-4-7"));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn unknown_keys_pass_through() {
        let _g = EnvGuard::new(&[]);
        let tmp = std::env::temp_dir().join("otherside-test-unknown-pt.json");
        fs::write(&tmp, r#"{"unexpectedKey":"value","nested":{"x":1}}"#).unwrap();
        let s = load_from(&tmp).unwrap();
        assert!(s.extra.contains_key("unexpectedKey"));
        assert!(s.extra.contains_key("nested"));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn malformed_json_surfaces_config_error() {
        let _g = EnvGuard::new(&[]);
        let tmp = std::env::temp_dir().join("otherside-test-malformed-mod.json");
        fs::write(&tmp, "not json at all").unwrap();
        let err = load_from(&tmp).unwrap_err();
        assert!(matches!(err, Error::Config(_)));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn settings_path_uses_override() {
        let _g = EnvGuard::new(&["OTHERSIDE_CONFIG_DIR"]);
        unsafe { std::env::set_var("OTHERSIDE_CONFIG_DIR", "/tmp/custom-otherside") };
        assert_eq!(
            settings_path().unwrap(),
            PathBuf::from("/tmp/custom-otherside/settings.json")
        );
        assert_eq!(
            credentials_path().unwrap(),
            PathBuf::from("/tmp/custom-otherside/credentials.json")
        );
    }

    #[test]
    fn resolve_user_only() {
        let (s, warnings) = resolve(&[SettingsSource::UserGlobal(
            json!({"defaultProvider":"anthropic-oauth"}),
        )]);
        assert_eq!(s.default_provider.as_deref(), Some("anthropic-oauth"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn resolve_project_overrides_user() {
        let (s, _) = resolve(&[
            SettingsSource::UserGlobal(json!({"defaultProvider":"anthropic-oauth"})),
            SettingsSource::ProjectLocal(json!({"defaultProvider":"codex"})),
        ]);
        assert_eq!(s.default_provider.as_deref(), Some("codex"));
    }

    #[test]
    fn resolve_flag_overrides_project() {
        let (s, _) = resolve(&[
            SettingsSource::UserGlobal(json!({"defaultProvider":"anthropic-oauth"})),
            SettingsSource::ProjectLocal(json!({"defaultProvider":"codex"})),
            SettingsSource::Flag(json!({"defaultProvider":"gemini-cli"})),
        ]);
        assert_eq!(s.default_provider.as_deref(), Some("gemini-cli"));
    }

    #[test]
    fn resolve_policy_beats_everything() {
        let (s, _) = resolve(&[
            SettingsSource::UserGlobal(json!({"defaultProvider":"anthropic-oauth"})),
            SettingsSource::ProjectLocal(json!({"defaultProvider":"codex"})),
            SettingsSource::Flag(json!({"defaultProvider":"gemini-cli"})),
            SettingsSource::Policy(json!({"defaultProvider":"openai-compatible"})),
        ]);
        assert_eq!(s.default_provider.as_deref(), Some("openai-compatible"));
    }

    #[test]
    fn resolve_passes_permission_mode_through_as_extra_not_typed_field() {

        let (s, _) = resolve(&[
            SettingsSource::UserGlobal(json!({"permissionMode":"default"})),
            SettingsSource::Policy(json!({"permissionMode":"yolo"})),
        ]);
        assert_eq!(
            s.extra.get("permissionMode"),
            Some(&json!("yolo"))
        );
    }

    #[test]
    fn resolve_array_concat_across_scopes() {

        let (s, _) = resolve(&[
            SettingsSource::UserGlobal(json!({
                "permissions":{"deny":[{"toolName":"Bash","matchPattern":"rm -rf *"}]}
            })),
            SettingsSource::ProjectLocal(json!({
                "permissions":{"deny":[{"toolName":"Bash","matchPattern":"sudo *"}]}
            })),
            SettingsSource::Policy(json!({
                "permissions":{"deny":[{"toolName":"Write","matchPattern":"**/secrets/**"}]}
            })),
        ]);
        let p = s.permissions.unwrap();
        assert_eq!(p.deny.len(), 3);
    }

    #[test]
    fn resolve_drops_invalid_rules_with_warning() {

        let (s, warnings) = resolve(&[SettingsSource::UserGlobal(json!({
            "permissions":{"allow":[
                {"toolName":"Read","matchPattern":"*"},
                {"toolName":"Bash"}
            ]}
        }))]);
        let p = s.permissions.unwrap();
        assert_eq!(p.allow.len(), 1);
        assert_eq!(p.allow[0].tool_name.as_deref(), Some("Read"));
        assert!(warnings
            .iter()
            .any(|w| matches!(w.kind, WarningKind::InvalidPermissionRule)));
    }

    #[test]
    fn resolve_unknown_top_level_key_warns() {
        let (_, warnings) = resolve(&[SettingsSource::UserGlobal(json!({
            "experimentalFutureKey": 42
        }))]);
        assert!(warnings
            .iter()
            .any(|w| matches!(w.kind, WarningKind::UnknownTopLevelKey)
                && w.detail == "experimentalFutureKey"));
    }

    #[test]
    fn resolve_empty_returns_default() {
        let (s, warnings) = resolve(&[]);
        assert_eq!(s, Settings::default());
        assert!(warnings.is_empty());
    }

    #[test]
    fn load_all_caches_and_reset_cache_reruns() {
        let _g = EnvGuard::new(&["OTHERSIDE_CONFIG_DIR"]);
        let tmp = std::env::temp_dir().join("otherside-test-loadall");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp) };
        reset_cache();

        let first = load_all(Path::new("/"), Value::Object(Map::new())).unwrap();
        assert_eq!(first.settings.default_provider, None);

        fs::write(
            tmp.join("settings.json"),
            r#"{"defaultProvider":"anthropic-oauth"}"#,
        )
        .unwrap();
        let cached = load_all(Path::new("/"), Value::Object(Map::new())).unwrap();
        assert_eq!(cached.settings.default_provider, None, "cache still held");

        reset_cache();
        let fresh = load_all(Path::new("/"), Value::Object(Map::new())).unwrap();
        assert_eq!(
            fresh.settings.default_provider.as_deref(),
            Some("anthropic-oauth")
        );

        reset_cache();
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn write_atomic_lands_file() {
        let _g = EnvGuard::new(&[]);
        let tmp = std::env::temp_dir().join(format!(
            "otherside-atomic-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&tmp);
        write_atomic(&tmp, b"{\"x\":1}", false).unwrap();
        let got = fs::read(&tmp).unwrap();
        assert_eq!(&got, b"{\"x\":1}");
        fs::remove_file(&tmp).ok();
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_chmod_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!(
            "otherside-atomic-0600-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&tmp);
        write_atomic(&tmp, b"{}", true).unwrap();
        let meta = fs::metadata(&tmp).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn write_atomic_no_partial_file_on_parent_missing() {

        let tmp_root = std::env::temp_dir().join(format!(
            "otherside-atomic-mkdir-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp_root);
        let target = tmp_root.join("nested/child/file.json");
        write_atomic(&target, b"{\"ok\":true}", false).unwrap();
        assert!(target.exists());
        fs::remove_dir_all(&tmp_root).ok();
    }
}
