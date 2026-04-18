//! Configuration: `~/.otherside/settings.json` + env overlay.
//!
//! # Settings sources (in precedence order, highest first)
//!
//! 1. CLI flag (`--model`, `--provider`, `--config`) — applied in `main.rs`
//!    after [`load`] returns, by overwriting the relevant fields.
//! 2. Environment variables prefixed `OTHERSIDE_*`.
//! 3. User-global `~/.otherside/settings.json`.
//! 4. Built-in defaults.
//!
//! Only `OTHERSIDE_*` env is honored — no `CLAUDE_CODE_*` compat (C5).
//!
//! Project-local `./.otherside/settings.json` is planned for Phase 2 when
//! interactive mode lands (workspace concept).
//!
//! # Paths
//!
//! All paths are resolved via the `directories` crate so we correctly honor
//! custom HOME. We deliberately use `~/.otherside/` (a dotfile folder
//! inside HOME) rather than XDG_CONFIG_HOME so the layout matches the
//! user-facing documentation exactly and is portable across darwin/linux
//! without surprises.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Default settings file name inside the config directory.
const SETTINGS_FILENAME: &str = "settings.json";

/// Default credentials file name inside the config directory.
const CREDENTIALS_FILENAME: &str = "credentials.json";

/// The otherside config home. Defaults to `$HOME/.otherside`.
///
/// Exists as a function (not const) so tests can shadow via
/// `OTHERSIDE_CONFIG_DIR` without touching the real home directory.
pub fn config_dir() -> Result<PathBuf> {
    if let Some(override_dir) = std::env::var_os("OTHERSIDE_CONFIG_DIR") {
        return Ok(PathBuf::from(override_dir));
    }

    let base = directories::BaseDirs::new().ok_or_else(|| {
        Error::Config("could not determine home directory".to_string())
    })?;
    Ok(base.home_dir().join(".otherside"))
}

/// Absolute path to `settings.json`.
pub fn settings_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(SETTINGS_FILENAME))
}

/// Absolute path to `credentials.json`.
pub fn credentials_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(CREDENTIALS_FILENAME))
}

/// Top-level settings, mirrored into `~/.otherside/settings.json`.
///
/// All fields are optional so an empty or missing file round-trips to
/// `Settings::default()`. Users can add only the keys they care about.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    /// Default provider ID. One of `anthropic-oauth`, `codex`, `gemini-cli`,
    /// `openai-compatible`.
    pub default_provider: Option<String>,

    /// Default model ID, optionally with thinking suffix
    /// (e.g. `claude-opus-4-7(xhigh)`).
    pub default_model: Option<String>,

    /// Log level: `error` / `warn` / `info` / `debug` / `trace`.
    /// Overridden by `--verbose`, `--debug`, or `RUST_LOG`.
    pub log_level: Option<String>,

    /// Per-provider configuration.
    pub providers: ProviderSettings,
}

/// Per-provider settings (all optional — user opts in per provider).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderSettings {
    pub anthropic_oauth: Option<AnthropicOauthSettings>,
    pub codex: Option<CodexSettings>,
    pub gemini_cli: Option<GeminiCliSettings>,
    pub openai_compatible: Option<OpenAiCompatibleSettings>,
}

/// Anthropic OAuth provider settings. All knobs override fingerprint
/// defaults — usually left empty.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct AnthropicOauthSettings {
    /// Override OAuth client_id (corresponds to `CLAUDE_CODE_OAUTH_CLIENT_ID`
    /// upstream).
    pub client_id: Option<String>,

    /// Override OAuth base URL (FedStart deployments only). Corresponds to
    /// `CLAUDE_CODE_CUSTOM_OAUTH_URL` upstream.
    pub custom_oauth_url: Option<String>,

    /// Refresh safety margin in seconds. Token refreshes `safety_margin`
    /// seconds before `expires_at`.
    pub refresh_safety_margin_seconds: Option<u64>,
}

/// Codex (ChatGPT OAuth) provider settings. Populated post-MVP.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct CodexSettings {}

/// Gemini CLI (Google OAuth) provider settings. Populated post-MVP.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct GeminiCliSettings {}

/// OpenAI-compatible provider settings — requires user-supplied endpoint.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct OpenAiCompatibleSettings {
    /// Base URL, e.g. `https://api.openai.com` or `http://localhost:8080`.
    pub base_url: Option<String>,

    /// API key. Read from env `OTHERSIDE_OPENAI_COMPATIBLE_API_KEY` if unset.
    pub api_key: Option<String>,
}

/// Load settings from the default location (`~/.otherside/settings.json`).
///
/// If the file does not exist, returns `Settings::default()`. Other I/O
/// errors surface as `Error::Config`.
pub fn load() -> Result<Settings> {
    let path = settings_path()?;
    load_from(&path)
}

/// Load settings from a specific path (useful for `--config` flag).
///
/// - Missing file → `Settings::default()`
/// - Malformed JSON or unknown keys → `Error::Config`
///
/// After loading the file, environment overrides are applied via
/// [`apply_env_overrides`].
pub fn load_from(path: &Path) -> Result<Settings> {
    let mut settings = if path.exists() {
        let bytes = std::fs::read(path).map_err(|e| {
            Error::Config(format!("failed to read {}: {e}", path.display()))
        })?;
        serde_json::from_slice::<Settings>(&bytes).map_err(|e| {
            Error::Config(format!("malformed settings in {}: {e}", path.display()))
        })?
    } else {
        Settings::default()
    };

    apply_env_overrides(&mut settings);
    Ok(settings)
}

/// Apply `OTHERSIDE_*` environment variable overrides to a settings value.
///
/// The env-var → field mapping is narrow on purpose — only ergonomic
/// overrides are exposed, not every field.
pub fn apply_env_overrides(settings: &mut Settings) {
    if let Ok(v) = std::env::var("OTHERSIDE_PROVIDER") {
        settings.default_provider = Some(v);
    }
    if let Ok(v) = std::env::var("OTHERSIDE_MODEL") {
        settings.default_model = Some(v);
    }
    if let Ok(v) = std::env::var("OTHERSIDE_LOG_LEVEL") {
        settings.log_level = Some(v);
    }

    // Provider-specific env overrides.
    if let Ok(v) = std::env::var("OTHERSIDE_OPENAI_COMPATIBLE_BASE_URL") {
        let p = settings.providers.openai_compatible.get_or_insert_default();
        p.base_url = Some(v);
    }
    if let Ok(v) = std::env::var("OTHERSIDE_OPENAI_COMPATIBLE_API_KEY") {
        let p = settings.providers.openai_compatible.get_or_insert_default();
        p.api_key = Some(v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    // Env vars are process-global. Gate tests that read/write env with a
    // mutex so concurrent `cargo test` threads don't interleave.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Guard that clears the env vars we touch, then restores on drop.
    /// Keeps test isolation without leaking state between tests.
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
                // SAFETY: tests are single-threaded within the guard scope
                // via the mutex.
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
        let _g = EnvGuard::new(&[
            "OTHERSIDE_PROVIDER",
            "OTHERSIDE_MODEL",
            "OTHERSIDE_LOG_LEVEL",
            "OTHERSIDE_CONFIG_DIR",
        ]);
        let tmp = std::env::temp_dir().join("otherside-test-missing");
        let _ = fs::remove_dir_all(&tmp);
        unsafe { std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp) };

        let settings = load().unwrap();
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn parses_minimal_settings_file() {
        let _g = EnvGuard::new(&[
            "OTHERSIDE_PROVIDER",
            "OTHERSIDE_MODEL",
            "OTHERSIDE_LOG_LEVEL",
        ]);
        let tmp = std::env::temp_dir().join("otherside-test-parse.json");
        fs::write(
            &tmp,
            r#"{"default_provider":"anthropic-oauth","default_model":"claude-opus-4-7"}"#,
        )
        .unwrap();
        let settings = load_from(&tmp).unwrap();
        assert_eq!(settings.default_provider.as_deref(), Some("anthropic-oauth"));
        assert_eq!(settings.default_model.as_deref(), Some("claude-opus-4-7"));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn env_override_beats_file() {
        let _g = EnvGuard::new(&[
            "OTHERSIDE_PROVIDER",
            "OTHERSIDE_MODEL",
            "OTHERSIDE_LOG_LEVEL",
        ]);
        let tmp = std::env::temp_dir().join("otherside-test-env.json");
        fs::write(
            &tmp,
            r#"{"default_provider":"anthropic-oauth","default_model":"claude-opus-4-7"}"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("OTHERSIDE_PROVIDER", "codex");
            std::env::set_var("OTHERSIDE_MODEL", "gpt-5-codex(high)");
        }
        let settings = load_from(&tmp).unwrap();
        assert_eq!(settings.default_provider.as_deref(), Some("codex"));
        assert_eq!(settings.default_model.as_deref(), Some("gpt-5-codex(high)"));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn unknown_keys_rejected() {
        let _g = EnvGuard::new(&[]);
        let tmp = std::env::temp_dir().join("otherside-test-unknown.json");
        fs::write(&tmp, r#"{"unexpected_key":"value"}"#).unwrap();
        let err = load_from(&tmp).unwrap_err();
        assert!(matches!(err, Error::Config(_)), "got {err:?}");
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn malformed_json_surfaces_config_error() {
        let _g = EnvGuard::new(&[]);
        let tmp = std::env::temp_dir().join("otherside-test-malformed.json");
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
}
