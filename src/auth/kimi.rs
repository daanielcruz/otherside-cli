

use std::io::{self, BufRead, Write};
use std::path::Path;

use serde_json::{Map, Value};

use crate::config::{credentials_path, write_atomic};
use crate::error::{Error, Result};

pub const CREDENTIALS_KEY: &str = "kimi";

pub const ENV_VAR_CANONICAL: &str = "OTHERSIDE_KIMI_API_KEY";

pub const ENV_VAR_VENDOR: &str = "KIMI_API_KEY";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCreds {

    pub api_key: String,
}

pub fn load_credentials() -> Result<Option<CachedCreds>> {
    let path = credentials_path()?;
    load_credentials_from(&path)
}

pub fn load_credentials_from(path: &Path) -> Result<Option<CachedCreds>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .map_err(|e| Error::Config(format!("read {}: {e}", path.display())))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let map: Map<String, Value> = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Config(format!("malformed credentials {}: {e}", path.display())))?;
    let Some(entry) = map.get(CREDENTIALS_KEY) else {
        return Ok(None);
    };
    let creds: CachedCreds = serde_json::from_value(entry.clone()).map_err(|e| {
        Error::Config(format!("malformed kimi credentials entry: {e}"))
    })?;
    Ok(Some(creds))
}

pub fn save_credentials(creds: &CachedCreds) -> Result<()> {
    let path = credentials_path()?;
    save_credentials_to(&path, creds)
}

pub fn save_credentials_to(path: &Path, creds: &CachedCreds) -> Result<()> {
    let mut map: Map<String, Value> = if path.exists() {
        let bytes = std::fs::read(path)
            .map_err(|e| Error::Config(format!("read {}: {e}", path.display())))?;
        if bytes.is_empty() {
            Map::new()
        } else {
            serde_json::from_slice(&bytes).map_err(|e| {
                Error::Config(format!("malformed credentials {}: {e}", path.display()))
            })?
        }
    } else {
        Map::new()
    };
    map.insert(
        CREDENTIALS_KEY.to_string(),
        serde_json::to_value(creds).map_err(|e| Error::Config(format!("serialize: {e}")))?,
    );
    let bytes = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| Error::Config(format!("serialize credentials map: {e}")))?;
    write_atomic(path, &bytes, true)
}

pub fn clear_credentials() -> Result<()> {
    let path = credentials_path()?;
    clear_credentials_at(&path)
}

pub fn clear_credentials_at(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(path)
        .map_err(|e| Error::Config(format!("read {}: {e}", path.display())))?;
    if bytes.is_empty() {
        return Ok(());
    }
    let mut map: Map<String, Value> = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Config(format!("malformed credentials {}: {e}", path.display())))?;
    if map.remove(CREDENTIALS_KEY).is_none() {
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| Error::Config(format!("serialize credentials map: {e}")))?;
    write_atomic(path, &bytes, true)
}

pub fn api_key_from_env() -> Option<String> {
    if let Ok(v) = std::env::var(ENV_VAR_CANONICAL) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Ok(v) = std::env::var(ENV_VAR_VENDOR) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

pub async fn current_api_key() -> Result<String> {
    if let Some(key) = api_key_from_env() {
        return Ok(key);
    }
    let creds = load_credentials()?.ok_or_else(|| {
        Error::Auth(format!(
            "no kimi API key found — set ${ENV_VAR_CANONICAL} or run `otherside login --provider kimi`"
        ))
    })?;
    Ok(creds.api_key)
}

pub fn login<W: Write, R: BufRead>(mut stdout: W, mut stdin: R) -> Result<CachedCreds> {
    writeln!(
        stdout,
        "\nCreate or copy a Kimi Code API key from {}\n",
        crate::fingerprint::kimi::CONSOLE_URL
    )
    .map_err(|e| Error::Other(format!("stdout write: {e}")))?;
    write!(stdout, "Paste your Kimi API key: ")
        .map_err(|e| Error::Other(format!("stdout write: {e}")))?;
    stdout
        .flush()
        .map_err(|e| Error::Other(format!("stdout flush: {e}")))?;

    let mut input = String::new();
    stdin
        .read_line(&mut input)
        .map_err(|e| Error::Other(format!("stdin read: {e}")))?;
    let key = input.trim();
    if key.is_empty() {
        return Err(Error::Auth("empty kimi API key rejected".into()));
    }
    let creds = CachedCreds {
        api_key: key.to_string(),
    };
    save_credentials(&creds)?;
    Ok(creds)
}

pub fn login_interactive() -> Result<CachedCreds> {
    let stdout = io::stdout().lock();
    let stdin = io::stdin().lock();
    login(stdout, stdin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_cred_path(label: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "otherside-test-kimi-creds-{label}-{}.json",
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn load_returns_none_when_file_missing() {
        let p = tmp_cred_path("missing");
        assert!(load_credentials_from(&p).unwrap().is_none());
    }

    #[test]
    fn load_returns_none_when_our_provider_key_absent() {

        let p = tmp_cred_path("no-kimi-entry");
        std::fs::write(
            &p,
            r#"{"anthropic-oauth":{"accessToken":"at","refreshToken":"rt","expiresAt":0,"scopes":[]}}"#,
        )
        .unwrap();
        assert!(load_credentials_from(&p).unwrap().is_none());
    }

    #[test]
    fn save_then_load_round_trips_api_key() {
        let p = tmp_cred_path("round-trip");
        let creds = CachedCreds {
            api_key: "sk-kimi-xxxxx".into(),
        };
        save_credentials_to(&p, &creds).unwrap();
        let read = load_credentials_from(&p).unwrap().unwrap();
        assert_eq!(read, creds);
    }

    #[test]
    fn save_preserves_other_provider_entries() {

        let p = tmp_cred_path("multi-provider");
        std::fs::write(
            &p,
            r#"{"anthropic-oauth":{"accessToken":"at","refreshToken":"rt","expiresAt":0,"scopes":[]}}"#,
        )
        .unwrap();
        let creds = CachedCreds {
            api_key: "kimi-key".into(),
        };
        save_credentials_to(&p, &creds).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        let map: Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
        assert!(map.contains_key("anthropic-oauth"));
        assert!(map.contains_key("kimi"));
    }

    #[test]
    fn clear_only_removes_kimi_entry() {

        let p = tmp_cred_path("clear-isolated");
        std::fs::write(
            &p,
            r#"{"anthropic-oauth":{"accessToken":"at","refreshToken":"rt","expiresAt":0,"scopes":[]},"kimi":{"apiKey":"zzz"}}"#,
        )
        .unwrap();
        clear_credentials_at(&p).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        let map: Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
        assert!(map.contains_key("anthropic-oauth"));
        assert!(!map.contains_key("kimi"));
    }

    #[test]
    fn clear_is_noop_when_file_missing() {
        let p = tmp_cred_path("clear-missing");
        clear_credentials_at(&p).unwrap();
        assert!(!p.exists());
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let p = tmp_cred_path("perms");
        let creds = CachedCreds {
            api_key: "x".into(),
        };
        save_credentials_to(&p, &creds).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn load_rejects_malformed_json() {
        let p = tmp_cred_path("malformed");
        std::fs::write(&p, "not json").unwrap();
        let err = load_credentials_from(&p).unwrap_err();
        assert!(matches!(err, Error::Config(_)));
    }

    #[test]
    fn login_rejects_empty_input() {
        let stdin = std::io::Cursor::new(b"\n");
        let mut stdout: Vec<u8> = Vec::new();
        let err = login(&mut stdout, stdin).unwrap_err();
        assert!(matches!(err, Error::Auth(_)));
        let s = String::from_utf8(stdout).unwrap();

        assert!(s.contains("Kimi"));
        assert!(s.contains(crate::fingerprint::kimi::CONSOLE_URL));
    }

    #[test]
    fn env_var_constants_follow_otherside_naming_discipline() {

        assert_eq!(ENV_VAR_CANONICAL, "OTHERSIDE_KIMI_API_KEY");
        assert_eq!(ENV_VAR_VENDOR, "KIMI_API_KEY");
    }
}
