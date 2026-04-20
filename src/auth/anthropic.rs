//! Anthropic OAuth flow.
//!
//! # Flow
//!
//! 1. [`login`] — generate PKCE verifier + S256 challenge, print authorization
//!    URL to stdout, read the returned `code#state` from stdin, POST to
//!    `/v1/oauth/token` with `grant_type=authorization_code`.
//! 2. [`refresh`] — POST to the same endpoint with `grant_type=refresh_token`,
//!    persist the rotated token pair.
//! 3. [`authorization_header`] — proactively refresh if `expires_at` is
//!    within 60s of now, return `Bearer <access_token>`.
//!
//! # URLs / constants
//!
//! Single source of truth lives in `crate::fingerprint::anthropic`. This
//! module consumes the constants from there — do not duplicate.
//!
//! # Scopes
//!
//! - Login requests all 6: `org:create_api_key`, `user:profile`,
//!   `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`,
//!   `user:file_upload`.
//! - Refresh requests only 5 (drops `org:create_api_key`) — matches
//!   captured behavior.
//!
//! # Golden corpus
//!
//! - `fingerprint_corpus/oauth/login.request.json` — authorization_code exchange
//! - `fingerprint_corpus/oauth/refresh.request.json` — refresh_token exchange
//! - `fingerprint_corpus/oauth/refresh_behavior.md` — observed proactive-only refresh
//!
//! # Body construction discipline
//!
//! The body-building functions ([`build_login_body`], [`build_refresh_body`])
//! are pure: they take the variable inputs (code, verifier, refresh_token)
//! and return the exact bytes that must land on the wire. This split lets
//! conformance tests byte-diff against the golden corpus without spinning
//! up reqwest or any HTTP mock.
//!
//! # HTTP wiring (non-pure side)
//!
//! [`login`], [`refresh`], and [`authorization_header`] perform reqwest
//! calls and touch `~/.otherside/credentials.json`. They build on top of
//! the pure body functions. Token exchange posts use `axios/1.13.6` as
//! the User-Agent to match captured fingerprint (axios is Claude Code's
//! HTTP client for token endpoints; see MAPPING §Four distinct User-Agents).

use std::io::{self, BufRead, Write};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::config::credentials_path;
use crate::error::{Error, Result};
use crate::fingerprint::anthropic as fp;

/// Proactive refresh safety margin. If `expires_at - now < SAFETY_MARGIN`,
/// refresh BEFORE the outbound request. Captured Claude Code behavior —
/// see `fingerprint_corpus/oauth/refresh_behavior.md`.
const REFRESH_SAFETY_MARGIN: Duration = Duration::from_secs(60);

/// Provider key under which our CachedCreds live in
/// `~/.otherside/credentials.json`. Matches the stable provider ID used
/// by the registry.
pub const CREDENTIALS_KEY: &str = "anthropic-oauth";

/// Build the `grant_type=authorization_code` body that goes in the POST
/// to `/v1/oauth/token`.
///
/// Returns bytes (not a string) because the wire format is UTF-8 JSON with
/// no whitespace — `serde_json::to_vec` emits exactly that.
///
/// Key insertion order matches `fingerprint_corpus/oauth/login.request.json`:
/// `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `state`.
///
/// Relies on serde_json's `preserve_order` feature (enabled in Cargo.toml)
/// so the output key order matches insertion order.
pub fn build_login_body(auth_code: &str, state: &str, code_verifier: &str) -> Vec<u8> {
    let mut m = Map::new();
    m.insert("grant_type".into(), Value::String("authorization_code".into()));
    m.insert("code".into(), Value::String(auth_code.into()));
    m.insert(
        "redirect_uri".into(),
        Value::String(fp::OAUTH_REDIRECT_URI.into()),
    );
    m.insert("client_id".into(), Value::String(fp::CLIENT_ID.into()));
    m.insert("code_verifier".into(), Value::String(code_verifier.into()));
    m.insert("state".into(), Value::String(state.into()));
    serde_json::to_vec(&Value::Object(m)).expect("body serialization cannot fail")
}

/// Build the `grant_type=refresh_token` body that goes in the POST
/// to `/v1/oauth/token`.
///
/// Key order per corpus: `grant_type`, `refresh_token`, `client_id`, `scope`.
/// Scope string is space-separated in the specific order captured (which
/// is NOT alphabetical and NOT identical to `LOGIN_SCOPES`): profile,
/// inference, sessions:claude_code, mcp_servers, file_upload. Note that
/// `org:create_api_key` is absent from the refresh scope.
pub fn build_refresh_body(refresh_token: &str) -> Vec<u8> {
    let scope = fp::REFRESH_SCOPES.join(" ");
    let mut m = Map::new();
    m.insert("grant_type".into(), Value::String("refresh_token".into()));
    m.insert("refresh_token".into(), Value::String(refresh_token.into()));
    m.insert("client_id".into(), Value::String(fp::CLIENT_ID.into()));
    m.insert("scope".into(), Value::String(scope));
    serde_json::to_vec(&Value::Object(m)).expect("body serialization cannot fail")
}

/// Build the authorize URL the user pastes in their browser.
///
/// Format matches the URL captured in `fingerprint_corpus/`:
/// `https://claude.com/cai/oauth/authorize?code=true&client_id=...&response_type=code&redirect_uri=...&scope=...&code_challenge=...&code_challenge_method=S256&state=...`
///
/// Scope in this URL is **plus-joined** (`+`, not space-encoded as %20)
/// — empirical from captured URL. `url::Url::query_pairs_mut` uses `+`
/// for spaces by default, which matches.
pub fn build_authorize_url(code_challenge: &str, state: &str) -> url::Url {
    let mut u = url::Url::parse(fp::OAUTH_AUTHORIZE_URL).expect("authorize URL is static");
    // Mutate query with the exact key order observed in corpus.
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

/// Split the callback string `"<auth_code>#<state>"` that the user pastes
/// back after authorizing. Claude Code's callback page formats the
/// returned code this way.
///
/// Returns `(auth_code, state)` on success, or an error if the string is
/// not in the expected form.
pub fn parse_callback_input(input: &str) -> crate::error::Result<(String, String)> {
    // Accept leading/trailing whitespace — users copy-paste.
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

/// Generate a fresh random `state` value for the OAuth flow. 32-byte
/// base64url-nopad — matches the length Claude Code uses.
pub fn generate_state() -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Response body shape from `POST /v1/oauth/token`.
///
/// Same for both `authorization_code` and `refresh_token` exchanges —
/// captured behavior matches.
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

/// The last-written token state kept at `~/.otherside/credentials.json`
/// under key `anthropic-oauth`. Keyed by camelCase to match the upstream
/// Claude Code shape for tooling parity (cross-check against
/// `fingerprint_corpus/oauth/refresh_behavior.md` — Credentials file shape).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCreds {
    pub access_token: String,
    pub refresh_token: String,
    /// Epoch milliseconds when the access token expires.
    pub expires_at: u64,
    pub scopes: Vec<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

impl CachedCreds {
    /// True if the access token is within the proactive-refresh safety
    /// margin (or already past expiry). Called by
    /// [`authorization_header`] before every outbound request.
    pub fn needs_refresh(&self, now: SystemTime) -> bool {
        let now_ms = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let margin_ms = REFRESH_SAFETY_MARGIN.as_millis() as u64;
        self.expires_at.saturating_sub(margin_ms) <= now_ms
    }

    /// Build a [`CachedCreds`] from a fresh [`TokenResponse`]. Stamps
    /// `expires_at` as `now + expires_in * 1000` in epoch ms.
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
        }
    }
}

// =============================================================================
// Credentials file IO (`~/.otherside/credentials.json`)
// =============================================================================

/// Read the credentials for this provider from the default credentials
/// path. Returns `Ok(None)` when the file does not exist or the
/// `anthropic-oauth` key is absent — both are normal "not logged in"
/// states, not errors.
pub fn load_credentials() -> Result<Option<CachedCreds>> {
    let path = credentials_path()?;
    load_credentials_from(&path)
}

/// Read credentials from a specific path. Split from [`load_credentials`]
/// so tests can point at a temp directory without touching the real
/// home directory.
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

/// Write the credentials for this provider to the default path,
/// preserving any other providers' entries that already exist.
///
/// File permissions are clamped to `0600` on Unix so no other user on
/// the machine can read the plaintext bearer token (C4 accepts plaintext
/// but we at least make it private). The parent directory is created if
/// it does not exist.
pub fn save_credentials(creds: &CachedCreds) -> Result<()> {
    let path = credentials_path()?;
    save_credentials_to(&path, creds)
}

/// Write credentials to a specific path. See [`save_credentials`].
pub fn save_credentials_to(path: &Path, creds: &CachedCreds) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::Config(format!("mkdir {}: {e}", parent.display())))?;
    }

    // Merge into the existing file: we must not clobber other providers'
    // credentials if the user is also logged in to codex / gemini-cli.
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

    // Atomic-ish write: write to a sibling temp file, then rename over
    // the target. Avoids leaving a half-written credentials.json if the
    // process is killed mid-write.
    let tmp = path.with_extension("json.tmp");
    let encoded = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| Error::Config(format!("serialize creds map: {e}")))?;
    std::fs::write(&tmp, &encoded)
        .map_err(|e| Error::Config(format!("write {}: {e}", tmp.display())))?;

    // Clamp permissions to 0600 before rename (Unix only — Windows
    // respects ACLs differently and is out of scope per MVP).
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

/// Remove the `anthropic-oauth` entry from the credentials file. Used
/// by `otherside logout --provider anthropic-oauth`. Other providers'
/// entries are preserved. Returns Ok even if the file or the entry did
/// not exist — logout is idempotent.
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

// =============================================================================
// OAuth HTTP flows
// =============================================================================

/// Build a reqwest client configured with the fingerprint we use for
/// OAuth token exchanges (axios UA, generous timeout).
fn token_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(fp::UA_AXIOS)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(Error::from)
}

/// Subset of `GET /api/oauth/profile` we actually consume. Upstream
/// returns a much richer shape (`account.full_name`, `organization.uuid`,
/// etc.); we only parse the two fields needed to populate
/// `subscription_type` + `rate_limit_tier` on the cached creds. Unknown
/// sibling fields are tolerated.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ProfileResponse {
    pub organization: Option<ProfileOrganization>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ProfileOrganization {
    /// `claude_max` | `claude_pro` | `claude_enterprise` | `claude_team`.
    pub organization_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

/// Map upstream `organization.organization_type` → our canonical
/// `subscription_type` string. Mirrors upstream `fetchProfileInfo`
/// switch in `services/oauth/client.ts:370-387`.
pub fn subscription_type_from_org_type(org_type: &str) -> Option<&'static str> {
    match org_type {
        "claude_max" => Some("max"),
        "claude_pro" => Some("pro"),
        "claude_enterprise" => Some("enterprise"),
        "claude_team" => Some("team"),
        _ => None,
    }
}

/// Hit `GET /api/oauth/profile` with the supplied access token and
/// return the parsed response. Used to hydrate `subscription_type` +
/// `rate_limit_tier` on creds that were saved before this code path
/// existed (or whose refresh ran while the profile endpoint was
/// unreachable — upstream swallows that and falls back to null).
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

/// One-shot: if cached creds are missing `subscription_type`, fetch
/// the profile endpoint and persist the mapped value. Silent no-op
/// when creds are absent, already hydrated, or the endpoint errors —
/// upstream behavior is "best effort, never block login" for this
/// field (see `services/oauth/client.ts:1222` comment).
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

/// Run the interactive OAuth authorization-code flow end-to-end.
///
/// 1. Generate a fresh PKCE pair + random state.
/// 2. Print the authorize URL and prompt the user to paste the
///    `<code>#<state>` callback they receive in the browser.
/// 3. Exchange the code for an access+refresh token pair.
/// 4. Persist the result to `~/.otherside/credentials.json`.
///
/// I/O writer/reader params allow tests to drive the function without
/// touching real stdin/stdout. Production callers use
/// [`login_interactive`] which wires stdin/stdout automatically.
pub async fn login<W: Write, R: BufRead>(
    mut stdout: W,
    mut stdin: R,
) -> Result<CachedCreds> {
    let pair = super::pkce::PkcePair::generate();
    let state = generate_state();

    let url = build_authorize_url(&pair.challenge, &state);
    writeln!(stdout, "\nOpen this URL in your browser to authorize otherside:")
        .map_err(|e| Error::Other(format!("stdout write: {e}")))?;
    writeln!(stdout, "\n  {url}\n")
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
    let (code, returned_state) = parse_callback_input(&input)?;
    if returned_state != state {
        return Err(Error::Auth(format!(
            "state mismatch: sent {state}, got {returned_state}"
        )));
    }

    let body = build_login_body(&code, &returned_state, &pair.verifier);
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

/// Convenience wrapper: drive [`login`] using real stdin/stdout.
pub async fn login_interactive() -> Result<CachedCreds> {
    let stdout = io::stdout().lock();
    let stdin = io::stdin().lock();
    login(stdout, stdin).await
}

/// Exchange a refresh_token for a fresh access+refresh pair.
///
/// Called proactively by [`authorization_header`] — never reactively in
/// response to a 401, because that would diverge from observed Claude
/// Code behavior (see refresh_behavior.md).
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

/// Return `Bearer <access_token>` ready to be attached to an outbound
/// inference request.
///
/// Proactively refreshes if `expires_at - now < REFRESH_SAFETY_MARGIN`.
/// Errors with [`Error::Auth`] if there are no credentials at all — the
/// CLI surface surfaces this as exit code 10 with a hint to run
/// `otherside login`.
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

    /// Load a captured body field from the corpus JSON at the given path
    /// and return the exact expected bytes (axios-style compact JSON).
    fn corpus_body(path: &str) -> Vec<u8> {
        let raw = std::fs::read_to_string(path).expect("corpus file should exist");
        let v: Value = serde_json::from_str(&raw).expect("corpus is valid JSON");
        // The corpus file wraps the expected body under "body". Key order
        // in corpus file IS the wire order (we enabled preserve_order in
        // serde_json).
        serde_json::to_vec(&v["body"]).expect("serialize expected body")
    }

    #[test]
    fn login_body_matches_corpus_key_order() {
        let corpus_path = "../fingerprint_corpus/oauth/login.request.json";
        let expected = corpus_body(corpus_path);

        // Reconstruct with the exact placeholder values used by the
        // corpus scrubber. Byte equality proves key order + encoding
        // match.
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
    fn login_body_matches_handwritten_bytes_exactly() {
        // Belt-and-suspenders: even if corpus parsing reordered keys, this
        // hand-written expected forces us to emit axios-style compact
        // JSON in exactly the captured sequence.
        let expected = concat!(
            r#"{"grant_type":"authorization_code","#,
            r#""code":"XXX_AUTH_CODE_XXX","#,
            r#""redirect_uri":"https://platform.claude.com/oauth/code/callback","#,
            r#""client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","#,
            r#""code_verifier":"XXX_CODE_VERIFIER_XXX","#,
            r#""state":"XXX_STATE_XXX"}"#,
        );
        let actual = build_login_body(
            "XXX_AUTH_CODE_XXX",
            "XXX_STATE_XXX",
            "XXX_CODE_VERIFIER_XXX",
        );
        assert_eq!(std::str::from_utf8(&actual).unwrap(), expected);
    }

    #[test]
    fn refresh_body_matches_handwritten_bytes_exactly() {
        // Hand-written belt-and-suspenders. Scope string order per corpus
        // notes: profile, inference, sessions:claude_code, mcp_servers,
        // file_upload (5 scopes; org:create_api_key absent).
        let expected = concat!(
            r#"{"grant_type":"refresh_token","#,
            r#""refresh_token":"XXX_REFRESH_TOKEN_XXX","#,
            r#""client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","#,
            r#""scope":"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"}"#,
        );
        let actual = build_refresh_body("XXX_REFRESH_TOKEN_XXX");
        assert_eq!(std::str::from_utf8(&actual).unwrap(), expected);
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
        // We can't byte-match URL order because serde JSON doesn't
        // influence URL encoding. Instead: assert the query params are
        // present in the right order and scope has all 6 login scopes.
        let u = build_authorize_url("CHAL", "STATE");
        let qs = u.query().unwrap_or("");
        // The `?` params appear in the order we appended them.
        assert!(qs.starts_with("code=true&client_id="));
        assert!(qs.contains(&format!("client_id={}", fp::CLIENT_ID)));
        assert!(qs.contains("response_type=code"));
        // URL encoding replaces ':' with %3A and spaces with +.
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

        // Real pasted value often has leading/trailing whitespace.
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

    // -----------------------------------------------------------------
    // CachedCreds — needs_refresh + from_token_response
    // -----------------------------------------------------------------

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
        // 8h expiry is the captured default — verify expires_at lands in
        // the future and scopes split on whitespace preserving order.
        let creds = CachedCreds::from_token_response(&fresh_token(28800, "at"));
        assert_eq!(creds.access_token, "at");
        assert_eq!(creds.scopes, vec!["user:inference", "user:profile"]);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(creds.expires_at > now_ms);
        // Window should be within 28800s + a small skew.
        assert!(creds.expires_at - now_ms <= 28_800_000 + 5_000);
    }

    #[test]
    fn needs_refresh_true_when_past_expiry() {
        // Expired 10s ago: needs_refresh MUST be true regardless of
        // safety margin.
        let creds = CachedCreds {
            access_token: "x".into(),
            refresh_token: "y".into(),
            expires_at: 0,
            scopes: vec![],
            subscription_type: None,
            rate_limit_tier: None,
        };
        assert!(creds.needs_refresh(SystemTime::now()));
    }

    #[test]
    fn needs_refresh_true_within_safety_margin() {
        // Expires in 30s (< 60s margin): needs refresh now.
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
        };
        assert!(creds.needs_refresh(now));
    }

    #[test]
    fn needs_refresh_false_when_plenty_of_time_left() {
        // Expires in 1 hour: plenty of time, do not refresh.
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
        };
        assert!(!creds.needs_refresh(now));
    }

    // -----------------------------------------------------------------
    // Credentials file IO
    // -----------------------------------------------------------------

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
        };
        save_credentials_to(&p, &creds).unwrap();
        let read = load_credentials_from(&p).unwrap().unwrap();
        assert_eq!(read, creds);
    }

    #[test]
    fn save_preserves_other_provider_entries() {
        // If the user is logged in to multiple providers, saving our
        // entry must not delete theirs.
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
        // File exists but only has entries for other providers.
        let p = tmp_cred_path("no-entry");
        std::fs::write(&p, r#"{"codex":{"accessToken":"x","refreshToken":"y","expiresAt":0,"scopes":[]}}"#)
            .unwrap();
        assert!(load_credentials_from(&p).unwrap().is_none());
    }
}
