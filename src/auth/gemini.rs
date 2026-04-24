
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{Map, Value};
use url::Url;

use crate::config::credentials_path;
use crate::error::{Error, Result};
use crate::fingerprint::gemini as fp;

use super::pkce::PkcePair;

pub const CREDENTIALS_KEY: &str = "gemini";

pub const REFRESH_SAFETY_MARGIN: Duration = Duration::from_secs(60);

pub const CALLBACK_PATH: &str = "/oauth2callback";

pub fn build_authorize_url(challenge: &str, state: &str, port: u16) -> Url {
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let scopes = fp::scopes_joined();
    let mut url = Url::parse(fp::OAUTH_AUTHORIZE_URL).expect("static url parses");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", fp::OAUTH_CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &scopes)
        .append_pair("access_type", "offline")
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "consent")
        .append_pair("state", state);
    url
}

pub fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    use rand::RngCore;
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExchangedTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RefreshedTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCreds {
    pub access_token: String,

    #[serde(default)]
    pub refresh_token: String,

    pub expires_at: u64,

    #[serde(default)]
    pub scopes: Vec<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
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

    pub fn from_exchange(resp: &ExchangedTokens) -> Self {
        let expires_at = compute_expires_at_ms(resp.expires_in);
        let scopes = resp
            .scope
            .as_deref()
            .map(|s| s.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default();
        Self {
            access_token: resp.access_token.clone(),
            refresh_token: resp.refresh_token.clone().unwrap_or_default(),
            id_token: resp.id_token.clone(),
            expires_at,
            scopes,
            email: None,
            project_id: None,
        }
    }

    pub fn apply_refresh(&mut self, refreshed: &RefreshedTokens) {
        self.access_token = refreshed.access_token.clone();
        self.expires_at = compute_expires_at_ms(refreshed.expires_in);
        if let Some(rt) = refreshed.refresh_token.as_ref() {
            if !rt.is_empty() {
                self.refresh_token = rt.clone();
            }
        }
        if let Some(id) = refreshed.id_token.as_ref() {
            self.id_token = Some(id.clone());
        }
        if let Some(s) = refreshed.scope.as_deref() {
            self.scopes = s.split_whitespace().map(str::to_string).collect();
        }
    }
}

fn compute_expires_at_ms(expires_in_secs: Option<u64>) -> u64 {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    now_ms.saturating_add(expires_in_secs.unwrap_or(3600).saturating_mul(1000))
}

pub async fn exchange_code_for_tokens(
    code: &str,
    verifier: &str,
    port: u16,
) -> Result<ExchangedTokens> {
    let client = crate::tools::http::apply_extra_ca_roots(
        reqwest::Client::builder().timeout(Duration::from_secs(30)),
    )
    .build()
    .map_err(|e| Error::Other(format!("http client: {e}")))?;
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", fp::OAUTH_CLIENT_ID),
        ("client_secret", fp::OAUTH_CLIENT_SECRET),
        ("code_verifier", verifier),
    ];
    let resp = client
        .post(fp::OAUTH_TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|e| Error::OauthExchange {
            provider: "gemini",
            detail: format!("token exchange: {e}"),
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| Error::OauthExchange {
        provider: "gemini",
        detail: format!("token body: {e}"),
    })?;
    if !status.is_success() {
        return Err(Error::OauthExchange {
            provider: "gemini",
            detail: format!("token exchange {status}: {body}"),
        });
    }
    serde_json::from_str::<ExchangedTokens>(&body).map_err(|e| Error::OauthExchange {
        provider: "gemini",
        detail: format!("token parse: {e} — body {body}"),
    })
}

pub async fn refresh_tokens(refresh_token: &str) -> Result<RefreshedTokens> {
    let client = crate::tools::http::apply_extra_ca_roots(
        reqwest::Client::builder().timeout(Duration::from_secs(30)),
    )
    .build()
    .map_err(|e| Error::Other(format!("http client: {e}")))?;
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", fp::OAUTH_CLIENT_ID),
        ("client_secret", fp::OAUTH_CLIENT_SECRET),
    ];
    let resp = client
        .post(fp::OAUTH_TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|e| Error::OauthExchange {
            provider: "gemini",
            detail: format!("refresh: {e}"),
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| Error::OauthExchange {
        provider: "gemini",
        detail: format!("refresh body: {e}"),
    })?;
    if !status.is_success() {
        return Err(Error::OauthExchange {
            provider: "gemini",
            detail: format!("refresh {status}: {body}"),
        });
    }
    serde_json::from_str::<RefreshedTokens>(&body).map_err(|e| Error::OauthExchange {
        provider: "gemini",
        detail: format!("refresh parse: {e} — body {body}"),
    })
}

pub async fn fetch_user_email(access_token: &str) -> Result<Option<String>> {
    let client = crate::tools::http::apply_extra_ca_roots(
        reqwest::Client::builder().timeout(Duration::from_secs(10)),
    )
    .build()
    .map_err(|e| Error::Other(format!("http client: {e}")))?;
    let resp = client
        .get(fp::USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| Error::Other(format!("userinfo: {e}")))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("userinfo parse: {e}")))?;
    Ok(body
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_string))
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
    let creds: CachedCreds = serde_json::from_value(entry.clone())
        .map_err(|e| Error::Config(format!("malformed gemini credentials: {e}")))?;
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
        if bytes.is_empty() {
            Map::new()
        } else {
            serde_json::from_slice(&bytes).unwrap_or_default()
        }
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
    let mut map: Map<String, Value> = serde_json::from_slice(&bytes).unwrap_or_default();
    if map.remove(CREDENTIALS_KEY).is_none() {
        return Ok(());
    }
    if map.is_empty() {
        std::fs::remove_file(path)
            .map_err(|e| Error::Config(format!("rm {}: {e}", path.display())))?;
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| Error::Config(format!("serialize: {e}")))?;
    crate::config::write_atomic(path, &bytes, true)
}

pub fn bind_callback_port() -> Result<(TcpListener, u16)> {
    for port in fp::OAUTH_CALLBACK_PORT_START..fp::OAUTH_CALLBACK_PORT_END {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok((listener, port));
        }
    }
    Err(Error::Other(format!(
        "could not bind any port in {}..{} for the gemini OAuth callback",
        fp::OAUTH_CALLBACK_PORT_START, fp::OAUTH_CALLBACK_PORT_END
    )))
}

pub fn wait_for_callback(listener: &TcpListener) -> Result<(String, String)> {
    listener
        .set_nonblocking(false)
        .map_err(|e| Error::Other(format!("listener non-blocking: {e}")))?;
    let (stream, _addr) = listener
        .accept()
        .map_err(|e| Error::Other(format!("accept callback: {e}")))?;
    parse_callback_stream(stream)
}

pub fn parse_callback_stream(mut stream: std::net::TcpStream) -> Result<(String, String)> {
    let reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|e| Error::Other(e.to_string()))?,
    );
    let mut first_line = String::new();
    {
        let mut lines = reader.lines();
        if let Some(Ok(line)) = lines.next() {
            first_line = line;
        }
    }

    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| Error::Other(format!("malformed callback line: {first_line:?}")))?;
    let full = format!("http://127.0.0.1{path}");
    let url = Url::parse(&full)
        .map_err(|e| Error::Other(format!("parse callback url {full}: {e}")))?;
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut err: Option<String> = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            "error" => err = Some(v.to_string()),
            _ => {}
        }
    }
    let redirect = format!(
        "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\n\r\n",
        fp::SIGN_IN_SUCCESS_URL
    );
    let _ = stream.write_all(redirect.as_bytes());
    let _ = stream.flush();
    if let Some(e) = err {
        return Err(Error::Other(format!("google oauth error: {e}")));
    }
    match (code, state) {
        (Some(c), Some(s)) => Ok((c, s)),
        _ => Err(Error::Other(format!(
            "callback missing code/state in {full:?}"
        ))),
    }
}

pub struct GeminiLoginHandshake {
    listener: Option<TcpListener>,
    port: u16,
    pkce: PkcePair,
    state: String,
    url: String,
}

impl GeminiLoginHandshake {
    pub fn authorize_url(&self) -> &str {
        &self.url
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn expected_state(&self) -> &str {
        &self.state
    }

    pub fn take_listener(&mut self) -> Option<TcpListener> {
        self.listener.take()
    }

    pub async fn finalize(self, code: String, returned_state: String) -> Result<CachedCreds> {
        if returned_state != self.state {
            return Err(Error::Other(format!(
                "state mismatch — got {returned_state:?}, expected {:?}",
                self.state
            )));
        }
        let tokens = exchange_code_for_tokens(&code, &self.pkce.verifier, self.port).await?;
        let mut creds = CachedCreds::from_exchange(&tokens);
        if let Ok(email) = fetch_user_email(&creds.access_token).await {
            creds.email = email;
        }
        save_credentials(&creds)?;
        Ok(creds)
    }
}

pub fn begin_login() -> Result<GeminiLoginHandshake> {
    let (listener, port) = bind_callback_port()?;
    let pkce = PkcePair::generate();
    let state = generate_state();
    let url = build_authorize_url(&pkce.challenge, &state, port).to_string();
    Ok(GeminiLoginHandshake {
        listener: Some(listener),
        port,
        pkce,
        state,
        url,
    })
}

pub async fn complete_login(mut handshake: GeminiLoginHandshake) -> Result<CachedCreds> {
    let listener = handshake
        .take_listener()
        .ok_or_else(|| Error::Other("gemini handshake missing listener".into()))?;
    let (code, returned_state) =
        tokio::task::spawn_blocking(move || wait_for_callback(&listener))
            .await
            .map_err(|e| Error::Other(format!("callback task: {e}")))??;

    handshake.finalize(code, returned_state).await
}

pub async fn login_interactive() -> Result<CachedCreds> {
    let handshake = begin_login()?;
    let url = handshake.authorize_url().to_string();
    let port = handshake.port();

    println!("Authorize otherside with Google — open this URL in your browser:");
    println!();
    println!("  {url}");
    println!();
    println!("Waiting for the callback on 127.0.0.1:{port}…");

    let _ = super::browser::try_open(&url);

    complete_login(handshake).await
}

pub async fn current_credentials() -> Result<CachedCreds> {
    let mut creds = load_credentials()?.ok_or_else(|| {
        Error::Auth("not logged in — run `otherside login --provider gemini`".into())
    })?;
    if creds.needs_refresh(SystemTime::now()) {
        if creds.refresh_token.is_empty() {
            return Err(Error::Auth(
                "gemini access token expired and no refresh_token saved — re-login".into(),
            ));
        }
        let refreshed = refresh_tokens(&creds.refresh_token).await?;
        creds.apply_refresh(&refreshed);
        save_credentials(&creds)?;
    }
    Ok(creds)
}

pub async fn authorization_header() -> Result<String> {
    let creds = current_credentials().await?;
    Ok(format!("Bearer {}", creds.access_token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_has_required_params() {
        let url = build_authorize_url("CHALLENGE", "STATE", 8085);
        let qs: std::collections::HashMap<String, String> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(qs.get("client_id"), Some(&fp::OAUTH_CLIENT_ID.to_string()));
        assert_eq!(qs.get("code_challenge"), Some(&"CHALLENGE".to_string()));
        assert_eq!(qs.get("code_challenge_method"), Some(&"S256".to_string()));
        assert_eq!(qs.get("response_type"), Some(&"code".to_string()));
        assert_eq!(qs.get("access_type"), Some(&"offline".to_string()));
        assert_eq!(qs.get("state"), Some(&"STATE".to_string()));
        assert_eq!(
            qs.get("redirect_uri"),
            Some(&format!("http://127.0.0.1:8085{CALLBACK_PATH}"))
        );
        let scopes = qs.get("scope").unwrap();
        assert!(scopes.contains("cloud-platform"));
        assert!(scopes.contains("userinfo.email"));
    }

    #[test]
    fn generate_state_is_random() {
        let a = generate_state();
        let b = generate_state();
        assert_ne!(a, b);
        assert!(a.len() >= 40);
    }

    #[test]
    fn cached_creds_round_trip_serde() {
        let creds = CachedCreds {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at: 1_700_000_000_000,
            scopes: vec!["openid".into()],
            email: Some("a@b.com".into()),
            project_id: Some("my-proj".into()),
            id_token: Some("idt".into()),
        };
        let json = serde_json::to_string(&creds).unwrap();
        assert!(json.contains("\"accessToken\":\"at\""));
        assert!(json.contains("\"refreshToken\":\"rt\""));
        assert!(json.contains("\"expiresAt\":1700000000000"));
        let back: CachedCreds = serde_json::from_str(&json).unwrap();
        assert_eq!(back, creds);
    }

    #[test]
    fn save_load_round_trip() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside_gemini_creds_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let creds = CachedCreds {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            expires_at: 0,
            scopes: vec!["openid".into()],
            email: None,
            project_id: None,
            id_token: None,
        };
        save_credentials_to(&tmp, &creds).unwrap();
        let loaded = load_credentials_from(&tmp).unwrap().expect("present");
        assert_eq!(loaded, creds);
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn save_preserves_other_provider_entries() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside_gemini_multi_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(
            &tmp,
            r#"{"anthropic-oauth":{"accessToken":"at","refreshToken":"rt","expiresAt":0,"scopes":[]}}"#,
        )
        .unwrap();
        let creds = CachedCreds {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 0,
            scopes: vec![],
            email: None,
            project_id: None,
            id_token: None,
        };
        save_credentials_to(&tmp, &creds).unwrap();
        let bytes = std::fs::read(&tmp).unwrap();
        let map: Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
        assert!(map.contains_key("anthropic-oauth"));
        assert!(map.contains_key("gemini"));
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn clear_only_removes_gemini_entry() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside_gemini_clear_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(
            &tmp,
            r#"{"anthropic-oauth":{"accessToken":"at","refreshToken":"rt","expiresAt":0,"scopes":[]},"gemini":{"accessToken":"x","refreshToken":"y","expiresAt":0,"scopes":[]}}"#,
        )
        .unwrap();
        clear_credentials_at(&tmp).unwrap();
        let bytes = std::fs::read(&tmp).unwrap();
        let map: Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
        assert!(map.contains_key("anthropic-oauth"));
        assert!(!map.contains_key("gemini"));
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn needs_refresh_returns_true_when_past_margin() {
        let now = SystemTime::now();
        let past = now - Duration::from_secs(120);
        let past_ms = past.duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        let creds = CachedCreds {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: past_ms,
            scopes: vec![],
            email: None,
            project_id: None,
            id_token: None,
        };
        assert!(creds.needs_refresh(now));
    }

    #[test]
    fn apply_refresh_preserves_refresh_token_when_omitted() {
        let mut creds = CachedCreds {
            access_token: "old-at".into(),
            refresh_token: "keep-me".into(),
            expires_at: 0,
            scopes: vec![],
            email: None,
            project_id: None,
            id_token: None,
        };
        let refreshed = RefreshedTokens {
            access_token: "new-at".into(),
            refresh_token: None,
            id_token: None,
            expires_in: Some(3600),
            scope: None,
        };
        creds.apply_refresh(&refreshed);
        assert_eq!(creds.access_token, "new-at");
        assert_eq!(creds.refresh_token, "keep-me");
        assert!(creds.expires_at > 0);
    }
}
