use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;

use crate::auth::codex as auth;
use crate::error::{Error, Result};
use crate::fingerprint::codex as fp;

const MODELS_ENDPOINT: &str = "/models";
const CACHE_TTL: Duration = Duration::from_secs(300);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

const CLIENT_VERSION_QUERY: &str = "0.124.0";

#[derive(Debug, Clone, Deserialize)]
pub struct CodexModel {
    pub slug: String,

    #[serde(default)]
    pub display_name: String,

    #[serde(default)]
    pub priority: u32,

    #[serde(default)]
    pub context_window: u64,

    #[serde(default)]
    pub max_context_window: u64,

    #[serde(default)]
    pub supported_in_api: bool,

    #[serde(default)]
    pub additional_speed_tiers: Vec<String>,
}

pub fn resolved_context_window(slug: &str) -> Option<u64> {
    if slug == "gpt-5.5" {
        return Some(400_000);
    }
    cached_models().iter().find(|m| m.slug == slug).map(|m| {
        if m.max_context_window > 0 {
            m.max_context_window
        } else {
            m.context_window
        }
    })
}

#[derive(Debug)]
struct Cache {
    models: Vec<CodexModel>,
    fetched_at: Instant,
}

static CACHE: OnceLock<RwLock<Option<Cache>>> = OnceLock::new();

fn cache() -> &'static RwLock<Option<Cache>> {
    CACHE.get_or_init(|| RwLock::new(None))
}

pub fn cached_models() -> Vec<CodexModel> {
    cache()
        .read()
        .ok()
        .and_then(|c| c.as_ref().map(|c| c.models.clone()))
        .unwrap_or_default()
}

pub async fn fetch_models() -> Result<Vec<CodexModel>> {
    let creds = auth::current_credentials().await?;
    let url = format!(
        "{}{}?client_version={}",
        fp::CHATGPT_BASE_URL,
        MODELS_ENDPOINT,
        CLIENT_VERSION_QUERY,
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        reqwest::header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", creds.access_token))
            .map_err(|e| Error::Header(format!("auth header: {e}")))?,
    );
    headers.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_str(&fp::user_agent())
            .map_err(|e| Error::Header(format!("ua header: {e}")))?,
    );
    if let Some(acct) = creds.account_id.as_deref() {
        headers.insert(
            HeaderName::from_static("chatgpt-account-id"),
            HeaderValue::from_str(acct)
                .map_err(|e| Error::Header(format!("account-id header: {e}")))?,
        );
    }

    let http = crate::tools::http::apply_extra_ca_roots(
        reqwest::Client::builder().timeout(FETCH_TIMEOUT),
    )
    .build()?;

    let res = http
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| Error::Other(format!("codex /models request: {e}")))?;

    if !res.status().is_success() {
        return Err(Error::Other(format!(
            "codex /models HTTP {}",
            res.status()
        )));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| Error::Other(format!("codex /models decode: {e}")))?;

    let arr = body
        .get("models")
        .or_else(|| body.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out: Vec<CodexModel> = Vec::with_capacity(arr.len());
    for v in arr {
        if let Ok(m) = serde_json::from_value::<CodexModel>(v) {
            out.push(m);
        }
    }

    out.retain(|m| m.slug != "codex-auto-review");
    out.sort_by_key(|m| m.priority);

    if let Ok(mut w) = cache().write() {
        *w = Some(Cache {
            models: out.clone(),
            fetched_at: Instant::now(),
        });
    }
    Ok(out)
}

pub fn supports_fast_tier(slug: &str) -> bool {
    cached_models()
        .iter()
        .find(|m| m.slug == slug)
        .map(|m| m.additional_speed_tiers.iter().any(|t| t == "fast"))
        .unwrap_or(false)
}

pub fn display_codex_name(slug: &str) -> String {
    let mapped = match slug {
        "gpt-5.5" => Some("GPT-5.5"),
        "gpt-5.4" => Some("GPT-5.4"),
        "gpt-5.4-mini" => Some("GPT-5.4 mini"),
        "gpt-5.3-codex" => Some("GPT-5.3 Codex"),
        "gpt-5.3-codex-spark" => Some("GPT-5.3 Codex Spark"),
        "gpt-5.2" => Some("GPT-5.2"),
        "codex-auto-review" => Some("Codex Auto-Review"),
        _ => None,
    };
    mapped.map(str::to_string).unwrap_or_else(|| slug.to_string())
}

pub async fn get_or_fetch() -> Vec<CodexModel> {
    if let Ok(r) = cache().read() {
        if let Some(c) = r.as_ref() {
            if c.fetched_at.elapsed() < CACHE_TTL {
                return c.models.clone();
            }
        }
    }
    fetch_models().await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_is_empty_before_fetch() {
        assert!(cached_models().is_empty());
    }

    #[test]
    fn codex_model_parses_minimal_shape() {
        let j = serde_json::json!({
            "slug": "gpt-5.4",
            "display_name": "GPT 5.4",
            "priority": 10,
            "context_window": 272000,
            "supported_in_api": true,
            "additional_speed_tiers": ["fast"]
        });
        let m: CodexModel = serde_json::from_value(j).unwrap();
        assert_eq!(m.slug, "gpt-5.4");
        assert_eq!(m.context_window, 272000);
        assert_eq!(m.additional_speed_tiers, vec!["fast"]);
    }

    #[test]
    fn codex_model_tolerates_missing_optional_fields() {
        let j = serde_json::json!({"slug": "gpt-5-mini"});
        let m: CodexModel = serde_json::from_value(j).unwrap();
        assert_eq!(m.slug, "gpt-5-mini");
        assert_eq!(m.display_name, "");
        assert!(m.additional_speed_tiers.is_empty());
    }
}
