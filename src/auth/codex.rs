//! Codex OAuth — ChatGPT authorization-code flow with PKCE.
//!
//! Mirrors the `openai/codex` Rust CLI (`codex-rs/login/src/`). Three
//! endpoints on `https://auth.openai.com/oauth/`:
//!
//! 1. `/oauth/authorize` — browser redirect with PKCE challenge + state
//! 2. `/oauth/token` — code-exchange (form-encoded, grant=authorization_code)
//! 3. `/oauth/token` — refresh (JSON body, grant=refresh_token)
//!
//! The optional api-key token exchange from upstream
//! (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`) is wired
//! but not invoked by default — we don't need the fallback API key for
//! ChatGPT-mode dispatch.
//!
//! # Callback server
//!
//! Upstream listens on `127.0.0.1:1455` with path `/auth/callback`. On
//! port collision they increment until a free port is found. We follow
//! the same pattern with a bare `tokio::net::TcpListener` — no `hyper`
//! dependency needed for the one request we accept.
//!
//! # Persistence
//!
//! Credentials land in `~/.otherside/credentials.json` under key
//! `codex`. Shape mirrors the anthropic entry but adds `id_token` and
//! `account_id` (extracted from the `https://api.openai.com/auth`
//! JWT claim, `chatgpt_account_id` subfield).
//!
//! Upstream spec is captured at
//! `docs/design/codex-openai-auth-api.md` (outer repo).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{Map, Value};
use url::Url;

use crate::config::credentials_path;
use crate::error::{Error, Result};

use super::pkce::PkcePair;

/// Upstream `codex_cli_rs` constants. R-20 / R-66: these are the
/// identifiers codex-cli broadcasts — impersonation requires exact
/// match.
pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const ISSUER: &str = "https://auth.openai.com";
pub const DEFAULT_PORT: u16 = 1455;
pub const CALLBACK_PATH: &str = "/auth/callback";
pub const SCOPE: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";

/// Proactive-refresh safety margin — refresh when the access token has
/// less than this long before expiry. Matches the 60s cushion the
/// anthropic path uses.
pub const REFRESH_SAFETY_MARGIN: Duration = Duration::from_secs(60);

/// Credentials-file key under `~/.otherside/credentials.json`.
pub const CREDENTIALS_KEY: &str = "codex";

// =============================================================================
// Authorize URL + callback parsing
// =============================================================================

/// Build the `oauth/authorize` URL that opens in the user's browser.
/// Query params mirror upstream `server.rs :: build_authorize_url`.
pub fn build_authorize_url(challenge: &str, state: &str, port: u16) -> Url {
    let redirect_uri = format!("http://localhost:{port}{CALLBACK_PATH}");
    let mut url = Url::parse(&format!("{ISSUER}/oauth/authorize")).expect("static url parses");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "codex_cli_rs");
    url
}

/// Generate a 32-byte URL-safe base64 state string — same shape as
/// upstream's random state.
pub fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    use rand::RngCore;
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

// =============================================================================
// Token exchange + refresh
// =============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExchangedTokens {
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RefreshedTokens {
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

/// POST `oauth/token` with `grant_type=authorization_code`. Form body.
pub async fn exchange_code_for_tokens(
    code: &str,
    verifier: &str,
    port: u16,
) -> Result<ExchangedTokens> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Error::Other(format!("http client: {e}")))?;
    let redirect_uri = format!("http://localhost:{port}{CALLBACK_PATH}");
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ];
    let resp = client
        .post(format!("{ISSUER}/oauth/token"))
        .header("User-Agent", codex_user_agent())
        .header("originator", "codex_cli_rs")
        .form(&form)
        .send()
        .await
        .map_err(|e| Error::Other(format!("codex token exchange: {e}")))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| Error::Other(format!("codex token body: {e}")))?;
    if !status.is_success() {
        return Err(Error::Other(format!(
            "codex token exchange {status}: {body}"
        )));
    }
    serde_json::from_str::<ExchangedTokens>(&body)
        .map_err(|e| Error::Other(format!("codex token parse: {e} — body {body}")))
}

/// POST `oauth/token` with `grant_type=refresh_token`. JSON body per
/// upstream `manager.rs :: request_chatgpt_token_refresh`.
pub async fn refresh_tokens(refresh_token: &str) -> Result<RefreshedTokens> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Error::Other(format!("http client: {e}")))?;
    let body = serde_json::json!({
        "client_id": CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    });
    let resp = client
        .post(format!("{ISSUER}/oauth/token"))
        .header("User-Agent", codex_user_agent())
        .header("originator", "codex_cli_rs")
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("codex refresh: {e}")))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| Error::Other(format!("codex refresh body: {e}")))?;
    if !status.is_success() {
        return Err(Error::Other(format!("codex refresh {status}: {body}")));
    }
    serde_json::from_str::<RefreshedTokens>(&body)
        .map_err(|e| Error::Other(format!("codex refresh parse: {e} — body {body}")))
}

/// Codex-native UA string. Mirrors upstream `default_client.rs :: get_codex_user_agent`
/// at a high level — versioned to our crate, platform appended.
fn codex_user_agent() -> String {
    format!(
        "codex_cli_rs/{} ({} {}; {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        "unknown",
        std::env::consts::ARCH,
    )
}

// =============================================================================
// JWT helpers
// =============================================================================

/// Decode the `exp` claim out of a JWT without verifying the signature —
/// we trust the upstream issuer over the wire; local expiry is used
/// only to drive proactive refresh.
pub fn parse_jwt_exp(jwt: &str) -> Option<u64> {
    let payload_b64 = jwt.split('.').nth(1)?;
    let payload_bytes = URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    let payload: Value = serde_json::from_slice(&payload_bytes).ok()?;
    payload
        .get("exp")
        .and_then(Value::as_u64)
        .or_else(|| payload.get("exp").and_then(Value::as_f64).map(|f| f as u64))
}

/// Extract the ChatGPT account id from a JWT's
/// `https://api.openai.com/auth.chatgpt_account_id` claim.
pub fn parse_jwt_account_id(jwt: &str) -> Option<String> {
    let payload_b64 = jwt.split('.').nth(1)?;
    let payload_bytes = URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    let payload: Value = serde_json::from_slice(&payload_bytes).ok()?;
    payload
        .get("https://api.openai.com/auth")
        .and_then(|a| a.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

// =============================================================================
// Credentials cache
// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCreds {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    /// ChatGPT workspace account UUID, extracted from the id_token
    /// JWT claim. Sent as `ChatGPT-Account-ID` header on every request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Epoch milliseconds when the access token expires (derived from
    /// the JWT `exp` claim).
    pub expires_at: u64,
    /// Granted scopes, space-joined as returned by the issuer (the
    /// refresh response doesn't echo scopes, so we cache the login-
    /// time set).
    #[serde(default)]
    pub scopes: Vec<String>,
}

impl CachedCreds {
    pub fn needs_refresh(&self, now: SystemTime) -> bool {
        let now_ms = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let margin_ms = REFRESH_SAFETY_MARGIN.as_millis() as u64;
        self.expires_at.saturating_sub(margin_ms) <= now_ms
    }

    /// Assemble from a fresh code-exchange response. Stamps
    /// `expires_at` from the access-token JWT `exp` claim.
    pub fn from_exchange(resp: &ExchangedTokens) -> Self {
        let exp_s = parse_jwt_exp(&resp.access_token).unwrap_or(0);
        let expires_at = exp_s.saturating_mul(1000);
        let account_id = parse_jwt_account_id(&resp.id_token);
        Self {
            access_token: resp.access_token.clone(),
            refresh_token: resp.refresh_token.clone(),
            id_token: resp.id_token.clone(),
            account_id,
            expires_at,
            scopes: SCOPE.split_whitespace().map(str::to_string).collect(),
        }
    }

    /// Merge a refresh response into `self`, replacing each field the
    /// response carried and leaving the others alone.
    pub fn apply_refresh(&mut self, refreshed: &RefreshedTokens) {
        if let Some(at) = refreshed.access_token.as_ref() {
            self.access_token = at.clone();
            self.expires_at = parse_jwt_exp(at).unwrap_or(0).saturating_mul(1000);
        }
        if let Some(rt) = refreshed.refresh_token.as_ref() {
            self.refresh_token = rt.clone();
        }
        if let Some(id) = refreshed.id_token.as_ref() {
            self.id_token = id.clone();
            if let Some(aid) = parse_jwt_account_id(id) {
                self.account_id = Some(aid);
            }
        }
    }
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
    let map: Map<String, Value> = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Config(format!("malformed credentials {}: {e}", path.display())))?;
    let Some(entry) = map.get(CREDENTIALS_KEY) else {
        return Ok(None);
    };
    let creds: CachedCreds = serde_json::from_value(entry.clone())
        .map_err(|e| Error::Config(format!("malformed codex credentials: {e}")))?;
    Ok(Some(creds))
}

pub fn save_credentials(creds: &CachedCreds) -> Result<()> {
    let path = credentials_path()?;
    save_credentials_to(&path, creds)
}

pub fn save_credentials_to(path: &Path, creds: &CachedCreds) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::Config(format!("mkdir {}: {e}", parent.display())))?;
    }
    let mut map: Map<String, Value> = if path.exists() {
        let bytes = std::fs::read(path)
            .map_err(|e| Error::Config(format!("read {}: {e}", path.display())))?;
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        Map::new()
    };
    map.insert(
        CREDENTIALS_KEY.to_string(),
        serde_json::to_value(creds).map_err(|e| Error::Config(format!("serialize: {e}")))?,
    );
    let bytes = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| Error::Config(format!("serialize credentials: {e}")))?;
    crate::config::write_atomic(path, &bytes, true)
}

pub fn clear_credentials() -> Result<()> {
    let path = credentials_path()?;
    if !path.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| Error::Config(format!("read {}: {e}", path.display())))?;
    let mut map: Map<String, Value> = serde_json::from_slice(&bytes).unwrap_or_default();
    map.remove(CREDENTIALS_KEY);
    if map.is_empty() {
        std::fs::remove_file(&path)
            .map_err(|e| Error::Config(format!("rm {}: {e}", path.display())))?;
    } else {
        let bytes = serde_json::to_vec_pretty(&Value::Object(map))
            .map_err(|e| Error::Config(format!("serialize: {e}")))?;
        crate::config::write_atomic(&path, &bytes, true)?;
    }
    Ok(())
}

// =============================================================================
// Interactive login — spin up local callback server
// =============================================================================

/// Listen on the first free port starting at [`DEFAULT_PORT`]. Mirrors
/// upstream's port-increment-on-collision behavior.
pub fn bind_callback_port() -> Result<(TcpListener, u16)> {
    for port in DEFAULT_PORT..DEFAULT_PORT + 32 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok((listener, port));
        }
    }
    Err(Error::Other(
        "could not bind any port in 1455..1487 for the codex OAuth callback".into(),
    ))
}

/// Accept one HTTP request on `listener` and parse the `code` + `state`
/// query params from the request line. Serves a short "you can close
/// this tab" response before returning.
pub fn wait_for_callback(listener: &TcpListener) -> Result<(String, String)> {
    listener
        .set_nonblocking(false)
        .map_err(|e| Error::Other(format!("listener non-blocking: {e}")))?;
    let (mut stream, _addr) = listener
        .accept()
        .map_err(|e| Error::Other(format!("accept callback: {e}")))?;
    let reader = BufReader::new(stream.try_clone().map_err(|e| Error::Other(e.to_string()))?);
    let mut first_line = String::new();
    {
        let mut lines = reader.lines();
        if let Some(Ok(line)) = lines.next() {
            first_line = line;
        }
    }
    // First line: `GET /auth/callback?code=...&state=... HTTP/1.1`
    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| Error::Other(format!("malformed callback line: {first_line:?}")))?;
    let full = format!("http://localhost{path}");
    let url = Url::parse(&full)
        .map_err(|e| Error::Other(format!("parse callback url {full}: {e}")))?;
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            _ => {}
        }
    }
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nLogin complete - you can close this tab.",
    );
    let _ = stream.flush();
    match (code, state) {
        (Some(c), Some(s)) => Ok((c, s)),
        _ => Err(Error::Other(format!(
            "callback missing code/state in {full:?}"
        ))),
    }
}

/// End-to-end login. Prints the authorize URL to stdout, opens the
/// browser, waits for the callback, exchanges the code, persists the
/// result.
pub async fn login_interactive() -> Result<CachedCreds> {
    let (listener, port) = bind_callback_port()?;
    let pkce = PkcePair::generate();
    let state = generate_state();
    let url = build_authorize_url(&pkce.challenge, &state, port);

    println!("Authorize otherside with ChatGPT — open this URL in your browser:");
    println!();
    println!("  {url}");
    println!();
    println!("Waiting for the callback on 127.0.0.1:{port}…");

    let (code, returned_state) = tokio::task::block_in_place(|| wait_for_callback(&listener))?;
    if returned_state != state {
        return Err(Error::Other(format!(
            "state mismatch — got {returned_state:?}, expected {state:?}"
        )));
    }
    let tokens = exchange_code_for_tokens(&code, &pkce.verifier, port).await?;
    let creds = CachedCreds::from_exchange(&tokens);
    save_credentials(&creds)?;
    Ok(creds)
}

/// Return a fresh `Authorization: Bearer …` header value, refreshing
/// proactively when the cached token is within the safety margin.
pub async fn authorization_header() -> Result<String> {
    let mut creds = load_credentials()?
        .ok_or_else(|| Error::Auth("not logged in — run `otherside login --provider codex`".into()))?;
    if creds.needs_refresh(SystemTime::now()) {
        let refreshed = refresh_tokens(&creds.refresh_token).await?;
        creds.apply_refresh(&refreshed);
        save_credentials(&creds)?;
    }
    Ok(format!("Bearer {}", creds.access_token))
}

/// Return the cached `CachedCreds` with the access token refreshed
/// if it's close to expiry. Convenience for provider callers that
/// need both the token and the `account_id` / `id_token` fields.
pub async fn current_credentials() -> Result<CachedCreds> {
    let mut creds = load_credentials()?
        .ok_or_else(|| Error::Auth("not logged in — run `otherside login --provider codex`".into()))?;
    if creds.needs_refresh(SystemTime::now()) {
        let refreshed = refresh_tokens(&creds.refresh_token).await?;
        creds.apply_refresh(&refreshed);
        save_credentials(&creds)?;
    }
    Ok(creds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_has_all_required_params() {
        let url = build_authorize_url("CHALLENGE", "STATE", 1455);
        let qs: std::collections::HashMap<String, String> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(qs.get("client_id"), Some(&CLIENT_ID.to_string()));
        assert_eq!(qs.get("code_challenge"), Some(&"CHALLENGE".to_string()));
        assert_eq!(qs.get("code_challenge_method"), Some(&"S256".to_string()));
        assert_eq!(qs.get("state"), Some(&"STATE".to_string()));
        assert_eq!(qs.get("response_type"), Some(&"code".to_string()));
        assert_eq!(qs.get("scope"), Some(&SCOPE.to_string()));
        assert_eq!(qs.get("originator"), Some(&"codex_cli_rs".to_string()));
        assert_eq!(
            qs.get("redirect_uri"),
            Some(&format!("http://localhost:1455{CALLBACK_PATH}"))
        );
    }

    #[test]
    fn parse_jwt_exp_reads_exp_claim() {
        // Hand-rolled JWT: header.{"exp":1745000000}.sig
        let header = URL_SAFE_NO_PAD.encode(b"{\"alg\":\"none\"}");
        let payload = URL_SAFE_NO_PAD.encode(b"{\"exp\":1745000000}");
        let jwt = format!("{header}.{payload}.sig");
        assert_eq!(parse_jwt_exp(&jwt), Some(1_745_000_000));
    }

    #[test]
    fn parse_jwt_account_id_reads_nested_claim() {
        let header = URL_SAFE_NO_PAD.encode(b"{\"alg\":\"none\"}");
        let payload = URL_SAFE_NO_PAD.encode(
            br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-xyz"}}"#,
        );
        let jwt = format!("{header}.{payload}.sig");
        assert_eq!(parse_jwt_account_id(&jwt), Some("acct-xyz".to_string()));
    }

    #[test]
    fn cached_creds_needs_refresh_when_past_margin() {
        let now = SystemTime::now();
        let past = now - Duration::from_secs(120);
        let past_ms = past
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let creds = CachedCreds {
            access_token: "a".into(),
            refresh_token: "r".into(),
            id_token: "i".into(),
            account_id: None,
            expires_at: past_ms,
            scopes: vec![],
        };
        assert!(creds.needs_refresh(now));
    }

    #[test]
    fn save_load_round_trip() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside_codex_creds_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let creds = CachedCreds {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            id_token: "id".into(),
            account_id: Some("acct-1".into()),
            expires_at: 0,
            scopes: vec!["openid".into()],
        };
        save_credentials_to(&tmp, &creds).unwrap();
        let loaded = load_credentials_from(&tmp).unwrap().expect("creds present");
        assert_eq!(loaded, creds);
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn generate_state_is_random() {
        let a = generate_state();
        let b = generate_state();
        assert_ne!(a, b);
        assert!(a.len() >= 40);
    }
}
