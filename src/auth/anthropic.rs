
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::config::credentials_path;
use crate::error::{Error, Result};
use crate::fingerprint::anthropic as fp;

const REFRESH_SAFETY_MARGIN: Duration = Duration::from_secs(60);

pub const CREDENTIALS_KEY: &str = "anthropic-oauth";

pub fn build_login_body(auth_code: &str, state: &str, code_verifier: &str) -> Vec<u8> {
    build_login_body_with_redirect(auth_code, state, code_verifier, fp::OAUTH_REDIRECT_URI)
}

pub fn build_login_body_with_redirect(
    auth_code: &str,
    state: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Vec<u8> {
    let mut m = Map::new();
    m.insert("grant_type".into(), Value::String("authorization_code".into()));
    m.insert("code".into(), Value::String(auth_code.into()));
    m.insert(
        "redirect_uri".into(),
        Value::String(redirect_uri.into()),
    );
    m.insert("client_id".into(), Value::String(fp::CLIENT_ID.into()));
    m.insert("code_verifier".into(), Value::String(code_verifier.into()));
    m.insert("state".into(), Value::String(state.into()));
    serde_json::to_vec(&Value::Object(m)).expect("body serialization cannot fail")
}

pub fn build_authorize_url_with_redirect(
    code_challenge: &str,
    state: &str,
    redirect_uri: &str,
) -> url::Url {
    let mut u = url::Url::parse(fp::OAUTH_AUTHORIZE_URL).expect("authorize URL is static");
    u.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", fp::CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &fp::LOGIN_SCOPES.join(" "))
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    u
}

pub fn build_refresh_body(refresh_token: &str) -> Vec<u8> {
    let scope = fp::REFRESH_SCOPES.join(" ");
    let mut m = Map::new();
    m.insert("grant_type".into(), Value::String("refresh_token".into()));
    m.insert("refresh_token".into(), Value::String(refresh_token.into()));
    m.insert("client_id".into(), Value::String(fp::CLIENT_ID.into()));
    m.insert("scope".into(), Value::String(scope));
    serde_json::to_vec(&Value::Object(m)).expect("body serialization cannot fail")
}

pub fn build_authorize_url(code_challenge: &str, state: &str) -> url::Url {
    let mut u = url::Url::parse(fp::OAUTH_AUTHORIZE_URL).expect("authorize URL is static");

    u.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", fp::CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", fp::OAUTH_REDIRECT_URI)
        .append_pair("scope", &fp::LOGIN_SCOPES.join(" "))
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    u
}

pub fn parse_callback_input(input: &str) -> crate::error::Result<(String, String)> {

    let input = input.trim();
    match input.split_once('#') {
        Some((code, state)) if !code.is_empty() && !state.is_empty() => {
            Ok((code.to_string(), state.to_string()))
        }
        _ => Err(crate::error::Error::Parse(format!(
            "callback input must be `<code>#<state>`, got {input:?}"
        ))),
    }
}

pub fn generate_state() -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct TokenResponse {
    pub token_type: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub scope: String,
    pub token_uuid: String,
    pub organization: OrganizationInfo,
    pub account: AccountInfo,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct OrganizationInfo {
    pub uuid: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct AccountInfo {
    pub uuid: String,
    pub email_address: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCreds {
    pub access_token: String,
    pub refresh_token: String,

    pub expires_at: u64,
    pub scopes: Vec<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_name: Option<String>,
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

    pub fn from_token_response(resp: &TokenResponse) -> Self {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let expires_at = now_ms + resp.expires_in * 1000;
        let scopes = resp
            .scope
            .split_whitespace()
            .map(str::to_string)
            .collect::<Vec<_>>();
        Self {
            access_token: resp.access_token.clone(),
            refresh_token: resp.refresh_token.clone(),
            expires_at,
            scopes,
            subscription_type: None,
            rate_limit_tier: None,
            account_email: Some(resp.account.email_address.clone()),
            organization_name: Some(resp.organization.name.clone()),
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
    let creds: CachedCreds = serde_json::from_value(entry.clone()).map_err(|e| {
        Error::Config(format!(
            "malformed credentials entry for {CREDENTIALS_KEY}: {e}"
        ))
    })?;
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
            serde_json::from_slice(&bytes)
                .map_err(|e| Error::Config(format!("malformed credentials {}: {e}", path.display())))?
        }
    } else {
        Map::new()
    };

    let entry = serde_json::to_value(creds)
        .map_err(|e| Error::Config(format!("serialize creds: {e}")))?;
    map.insert(CREDENTIALS_KEY.to_string(), entry);

    let tmp = path.with_extension("json.tmp");
    let encoded = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| Error::Config(format!("serialize creds map: {e}")))?;
    std::fs::write(&tmp, &encoded)
        .map_err(|e| Error::Config(format!("write {}: {e}", tmp.display())))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&tmp, perms)
            .map_err(|e| Error::Config(format!("chmod 0600 {}: {e}", tmp.display())))?;
    }

    std::fs::rename(&tmp, path)
        .map_err(|e| Error::Config(format!("rename {} → {}: {e}", tmp.display(), path.display())))?;
    Ok(())
}

pub fn clear_credentials() -> Result<()> {
    let path = credentials_path()?;
    if !path.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| Error::Config(format!("read {}: {e}", path.display())))?;
    if bytes.is_empty() {
        return Ok(());
    }
    let mut map: Map<String, Value> = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Config(format!("malformed credentials {}: {e}", path.display())))?;
    if map.remove(CREDENTIALS_KEY).is_none() {
        return Ok(());
    }
    let encoded = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| Error::Config(format!("serialize creds map: {e}")))?;
    std::fs::write(&path, encoded)
        .map_err(|e| Error::Config(format!("write {}: {e}", path.display())))?;
    Ok(())
}

fn token_http_client() -> Result<reqwest::Client> {
    crate::tools::http::apply_extra_ca_roots(
        reqwest::Client::builder()
            .user_agent(fp::UA_AXIOS)
            .timeout(Duration::from_secs(60)),
    )
    .build()
    .map_err(Error::from)
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ProfileResponse {
    pub organization: Option<ProfileOrganization>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ProfileOrganization {

    pub organization_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

pub fn subscription_type_from_org_type(org_type: &str) -> Option<&'static str> {
    match org_type {
        "claude_max" => Some("max"),
        "claude_pro" => Some("pro"),
        "claude_enterprise" => Some("enterprise"),
        "claude_team" => Some("team"),
        _ => None,
    }
}

pub async fn fetch_profile(access_token: &str) -> Result<ProfileResponse> {
    let client = token_http_client()?;
    let resp = client
        .get(fp::API_PROFILE_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(Error::Auth(format!(
            "profile fetch failed: HTTP {status}: {body_text}"
        )));
    }
    resp.json::<ProfileResponse>().await.map_err(Error::from)
}

pub async fn hydrate_subscription_if_missing() -> Result<()> {
    let Some(mut creds) = load_credentials()? else {
        return Ok(());
    };
    if creds.subscription_type.is_some() {
        return Ok(());
    }
    let profile = match fetch_profile(&creds.access_token).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(?e, "profile fetch failed — subscription_type stays null");
            return Ok(());
        }
    };
    let Some(org) = profile.organization else { return Ok(()); };
    if let Some(org_type) = org.organization_type.as_deref() {
        if let Some(sub) = subscription_type_from_org_type(org_type) {
            creds.subscription_type = Some(sub.to_string());
        }
    }
    if creds.rate_limit_tier.is_none() {
        creds.rate_limit_tier = org.rate_limit_tier;
    }
    save_credentials(&creds)?;
    Ok(())
}

pub struct LoginHandshake {
    pair: super::pkce::PkcePair,
    state: String,
    automatic_url: String,
    manual_url: String,
    listener: Option<std::net::TcpListener>,
    port: u16,
}

impl LoginHandshake {
    pub fn authorize_url(&self) -> &str {
        &self.manual_url
    }

    pub fn manual_url(&self) -> &str {
        &self.manual_url
    }

    pub fn automatic_url(&self) -> &str {
        &self.automatic_url
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn expected_state(&self) -> &str {
        &self.state
    }

    pub fn take_listener(&mut self) -> Option<std::net::TcpListener> {
        self.listener.take()
    }

    pub async fn finalize(
        self,
        code: String,
        returned_state: String,
        is_manual: bool,
    ) -> Result<CachedCreds> {
        if returned_state != self.state {
            return Err(Error::Auth(format!(
                "state mismatch: sent {}, got {returned_state}",
                self.state
            )));
        }
        let redirect_uri = if is_manual {
            fp::OAUTH_REDIRECT_URI.to_string()
        } else {
            format!("http://localhost:{}/callback", self.port)
        };
        let body = build_login_body_with_redirect(
            &code,
            &returned_state,
            &self.pair.verifier,
            &redirect_uri,
        );
        let client = token_http_client()?;
        let resp = client
            .post(fp::OAUTH_TOKEN_URL)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(Error::Auth(format!(
                "token exchange failed: HTTP {status}: {body_text}"
            )));
        }

        let token: TokenResponse = resp.json().await?;
        let creds = CachedCreds::from_token_response(&token);
        save_credentials(&creds)?;
        Ok(creds)
    }
}

pub fn begin_login() -> Result<LoginHandshake> {
    let pair = super::pkce::PkcePair::generate();
    let state = generate_state();
    let (listener, port) = bind_callback_port()?;
    let automatic_redirect = format!("http://localhost:{}/callback", port);
    let automatic_url =
        build_authorize_url_with_redirect(&pair.challenge, &state, &automatic_redirect)
            .to_string();
    let manual_url =
        build_authorize_url_with_redirect(&pair.challenge, &state, fp::OAUTH_REDIRECT_URI)
            .to_string();
    Ok(LoginHandshake {
        pair,
        state,
        automatic_url,
        manual_url,
        listener: Some(listener),
        port,
    })
}

pub fn bind_callback_port() -> Result<(std::net::TcpListener, u16)> {
    const LOW: u16 = 54545;
    const HIGH: u16 = LOW + 64;
    for port in LOW..HIGH {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Ok((listener, port));
        }
    }
    Err(Error::Other(
        "could not bind any port in 54545..54609 for the anthropic OAuth callback".into(),
    ))
}

pub fn parse_callback_stream(
    mut stream: std::net::TcpStream,
) -> Result<(String, String)> {
    use std::io::{BufRead, BufReader, Write};
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
    let full = format!("http://localhost{path}");
    let parsed = url::Url::parse(&full)
        .map_err(|e| Error::Other(format!("parse callback url {full}: {e}")))?;
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    for (k, v) in parsed.query_pairs() {
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

pub async fn complete_login(
    handshake: LoginHandshake,
    pasted: &str,
) -> Result<CachedCreds> {
    let (code, returned_state) = parse_callback_input(pasted)?;
    handshake.finalize(code, returned_state, true).await
}

pub async fn login<W: Write, R: BufRead>(
    mut stdout: W,
    mut stdin: R,
) -> Result<CachedCreds> {
    let handshake = begin_login()?;
    writeln!(stdout, "\nOpen this URL in your browser to authorize otherside:")
        .map_err(|e| Error::Other(format!("stdout write: {e}")))?;
    writeln!(stdout, "\n  {}\n", handshake.manual_url())
        .map_err(|e| Error::Other(format!("stdout write: {e}")))?;
    writeln!(
        stdout,
        "After authorizing, paste the `<code>#<state>` string from the callback page here:"
    )
    .map_err(|e| Error::Other(format!("stdout write: {e}")))?;
    write!(stdout, "> ")
        .map_err(|e| Error::Other(format!("stdout write: {e}")))?;
    stdout
        .flush()
        .map_err(|e| Error::Other(format!("stdout flush: {e}")))?;

    let mut input = String::new();
    stdin
        .read_line(&mut input)
        .map_err(|e| Error::Other(format!("stdin read: {e}")))?;
    complete_login(handshake, &input).await
}

pub async fn login_interactive() -> Result<CachedCreds> {
    let stdout = io::stdout().lock();
    let stdin = io::stdin().lock();
    login(stdout, stdin).await
}

pub async fn refresh(refresh_token: &str) -> Result<CachedCreds> {
    let body = build_refresh_body(refresh_token);
    let client = token_http_client()?;
    let resp = client
        .post(fp::OAUTH_TOKEN_URL)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(Error::Auth(format!(
            "refresh exchange failed: HTTP {status}: {body_text}"
        )));
    }

    let token: TokenResponse = resp.json().await?;
    let creds = CachedCreds::from_token_response(&token);
    save_credentials(&creds)?;
    Ok(creds)
}

pub async fn authorization_header() -> Result<String> {
    let creds = load_credentials()?.ok_or_else(|| {
        Error::Auth("no anthropic-oauth credentials — run `otherside login --provider anthropic-oauth`".to_string())
    })?;

    let effective = if creds.needs_refresh(SystemTime::now()) {
        refresh(&creds.refresh_token).await?
    } else {
        creds
    };

    Ok(format!("Bearer {}", effective.access_token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn corpus_body(path: &str) -> Vec<u8> {
        let raw = std::fs::read_to_string(path).expect("corpus file should exist");
        let v: Value = serde_json::from_str(&raw).expect("corpus is valid JSON");

        serde_json::to_vec(&v["body"]).expect("serialize expected body")
    }

    #[test]
    fn login_body_matches_corpus_key_order() {
        let corpus_path = "../fingerprint_corpus/oauth/login.request.json";
        let expected = corpus_body(corpus_path);

        let actual = build_login_body(
            "XXX_AUTH_CODE_XXX",
            "XXX_STATE_XXX",
            "XXX_CODE_VERIFIER_XXX",
        );

        assert_eq!(
            std::str::from_utf8(&actual).unwrap(),
            std::str::from_utf8(&expected).unwrap(),
            "login body bytes diverge from corpus"
        );
    }

    #[test]
    fn refresh_body_matches_corpus_key_order() {
        let corpus_path = "../fingerprint_corpus/oauth/refresh.request.json";
        let expected = corpus_body(corpus_path);

        let actual = build_refresh_body("XXX_REFRESH_TOKEN_XXX");

        assert_eq!(
            std::str::from_utf8(&actual).unwrap(),
            std::str::from_utf8(&expected).unwrap(),
            "refresh body bytes diverge from corpus"
        );
    }

    #[test]
    fn authorize_url_carries_all_params_in_observed_order() {

        let u = build_authorize_url("CHAL", "STATE");
        let qs = u.query().unwrap_or("");

        assert!(qs.starts_with("code=true&client_id="));
        assert!(qs.contains(&format!("client_id={}", fp::CLIENT_ID)));
        assert!(qs.contains("response_type=code"));

        assert!(qs.contains("scope=org%3Acreate_api_key+user%3Aprofile"));
        assert!(qs.contains("code_challenge=CHAL"));
        assert!(qs.contains("code_challenge_method=S256"));
        assert!(qs.contains("state=STATE"));
    }

    #[test]
    fn parse_callback_splits_code_hash_state() {
        let (code, state) = parse_callback_input("ABC#XYZ").unwrap();
        assert_eq!(code, "ABC");
        assert_eq!(state, "XYZ");

        let (code, state) = parse_callback_input("  KXJl9Z10ePZ#state_value  \n").unwrap();
        assert_eq!(code, "KXJl9Z10ePZ");
        assert_eq!(state, "state_value");
    }

    #[test]
    fn parse_callback_rejects_malformed() {
        assert!(parse_callback_input("no-hash-separator").is_err());
        assert!(parse_callback_input("#only-state").is_err());
        assert!(parse_callback_input("only-code#").is_err());
        assert!(parse_callback_input("").is_err());
    }

    #[test]
    fn generate_state_is_43_chars_base64url() {
        let s = generate_state();
        assert_eq!(s.len(), 43);
        for c in s.chars() {
            assert!(c.is_ascii_alphanumeric() || c == '-' || c == '_');
        }
    }

    #[test]
    fn two_generated_states_differ() {
        let a = generate_state();
        let b = generate_state();
        assert_ne!(a, b);
    }

    fn fresh_token(expires_in: u64, access: &str) -> TokenResponse {
        TokenResponse {
            token_type: "Bearer".into(),
            access_token: access.into(),
            refresh_token: "rt".into(),
            expires_in,
            scope: "user:inference user:profile".into(),
            token_uuid: "tu".into(),
            organization: OrganizationInfo {
                uuid: "ou".into(),
                name: "Org".into(),
            },
            account: AccountInfo {
                uuid: "au".into(),
                email_address: "u@example.com".into(),
            },
        }
    }

    #[test]
    fn cached_creds_from_token_response_populates_scope_and_expiry() {

        let creds = CachedCreds::from_token_response(&fresh_token(28800, "at"));
        assert_eq!(creds.access_token, "at");
        assert_eq!(creds.scopes, vec!["user:inference", "user:profile"]);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(creds.expires_at > now_ms);

        assert!(creds.expires_at - now_ms <= 28_800_000 + 5_000);
    }

    #[test]
    fn needs_refresh_true_when_past_expiry() {

        let creds = CachedCreds {
            access_token: "x".into(),
            refresh_token: "y".into(),
            expires_at: 0,
            scopes: vec![],
            subscription_type: None,
            rate_limit_tier: None,
            account_email: None,
            organization_name: None,
        };
        assert!(creds.needs_refresh(SystemTime::now()));
    }

    #[test]
    fn needs_refresh_true_within_safety_margin() {

        let now = SystemTime::now();
        let in_30s = now
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000;
        let creds = CachedCreds {
            access_token: "x".into(),
            refresh_token: "y".into(),
            expires_at: in_30s,
            scopes: vec![],
            subscription_type: None,
            rate_limit_tier: None,
            account_email: None,
            organization_name: None,
        };
        assert!(creds.needs_refresh(now));
    }

    #[test]
    fn needs_refresh_false_when_plenty_of_time_left() {

        let now = SystemTime::now();
        let in_1h = now
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 3_600_000;
        let creds = CachedCreds {
            access_token: "x".into(),
            refresh_token: "y".into(),
            expires_at: in_1h,
            scopes: vec![],
            subscription_type: None,
            rate_limit_tier: None,
            account_email: None,
            organization_name: None,
        };
        assert!(!creds.needs_refresh(now));
    }

    fn tmp_cred_path(label: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("otherside-test-creds-{label}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn load_credentials_returns_none_when_file_missing() {
        let p = tmp_cred_path("missing");
        assert!(load_credentials_from(&p).unwrap().is_none());
    }

    #[test]
    fn save_then_load_round_trip() {
        let p = tmp_cred_path("round-trip");
        let creds = CachedCreds {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at: 12345,
            scopes: vec!["user:profile".into()],
            subscription_type: Some("pro".into()),
            rate_limit_tier: None,
            account_email: None,
            organization_name: None,
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
            r#"{"codex":{"accessToken":"gpt","refreshToken":"gpt_r","expiresAt":0,"scopes":[]}}"#,
        )
        .unwrap();
        let creds = CachedCreds {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at: 12345,
            scopes: vec![],
            subscription_type: None,
            rate_limit_tier: None,
            account_email: None,
            organization_name: None,
        };
        save_credentials_to(&p, &creds).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        let map: Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
        assert!(map.contains_key("codex"), "codex entry must survive");
        assert!(map.contains_key("anthropic-oauth"));
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_has_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let p = tmp_cred_path("perms");
        let creds = CachedCreds {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at: 0,
            scopes: vec![],
            subscription_type: None,
            rate_limit_tier: None,
            account_email: None,
            organization_name: None,
        };
        save_credentials_to(&p, &creds).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "credentials file must be 0600, got {mode:o}");
    }

    #[test]
    fn load_rejects_malformed_json() {
        let p = tmp_cred_path("malformed");
        std::fs::write(&p, "not json").unwrap();
        let err = load_credentials_from(&p).unwrap_err();
        assert!(matches!(err, Error::Config(_)));
    }

    #[test]
    fn load_returns_none_when_our_provider_key_absent() {

        let p = tmp_cred_path("no-entry");
        std::fs::write(&p, r#"{"codex":{"accessToken":"x","refreshToken":"y","expiresAt":0,"scopes":[]}}"#)
            .unwrap();
        assert!(load_credentials_from(&p).unwrap().is_none());
    }
}
