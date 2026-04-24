use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderValue};
use serde::Deserialize;

use crate::auth::kimi as auth;
use crate::error::{Error, Result};

const MODELS_URL: &str = "https://api.kimi.com/coding/v1/models";
const CACHE_TTL: Duration = Duration::from_secs(300);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize)]
pub struct KimiModel {
    pub id: String,

    #[serde(default)]
    pub display_name: String,

    #[serde(default)]
    pub context_length: u64,

    #[serde(default)]
    pub supports_reasoning: bool,

    #[serde(default)]
    pub supports_image_in: bool,

    #[serde(default)]
    pub supports_video_in: bool,
}

impl KimiModel {
    pub fn has_thinking(&self) -> bool {
        self.supports_reasoning
            || self.id.starts_with("kimi-k2")
            || self.id.contains("thinking")
    }

    pub fn always_thinking(&self) -> bool {
        self.id.contains("thinking")
    }
}

struct Cache {
    models: Vec<KimiModel>,
    fetched_at: Instant,
}

static CACHE: OnceLock<RwLock<Option<Cache>>> = OnceLock::new();

fn cache() -> &'static RwLock<Option<Cache>> {
    CACHE.get_or_init(|| RwLock::new(None))
}

pub fn cached_models() -> Vec<KimiModel> {
    cache()
        .read()
        .ok()
        .and_then(|c| c.as_ref().map(|c| c.models.clone()))
        .unwrap_or_default()
}

pub async fn fetch_models() -> Result<Vec<KimiModel>> {
    let api_key = auth::current_api_key().await?;

    let mut headers = HeaderMap::new();
    headers.insert(
        reqwest::header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|e| Error::Header(format!("auth header: {e}")))?,
    );

    let http = crate::tools::http::apply_extra_ca_roots(
        reqwest::Client::builder().timeout(FETCH_TIMEOUT),
    )
    .build()?;

    let res = http
        .get(MODELS_URL)
        .headers(headers)
        .send()
        .await
        .map_err(|e| Error::Other(format!("kimi /models request: {e}")))?;

    if !res.status().is_success() {
        return Err(Error::Other(format!(
            "kimi /models HTTP {}",
            res.status()
        )));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| Error::Other(format!("kimi /models decode: {e}")))?;

    let arr = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out: Vec<KimiModel> = Vec::with_capacity(arr.len());
    for v in arr {
        if let Ok(m) = serde_json::from_value::<KimiModel>(v) {
            out.push(m);
        }
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));

    if let Ok(mut w) = cache().write() {
        *w = Some(Cache {
            models: out.clone(),
            fetched_at: Instant::now(),
        });
    }
    Ok(out)
}

pub async fn get_or_fetch() -> Vec<KimiModel> {
    if let Ok(r) = cache().read() {
        if let Some(c) = r.as_ref() {
            if c.fetched_at.elapsed() < CACHE_TTL {
                return c.models.clone();
            }
        }
    }
    fetch_models().await.unwrap_or_default()
}

pub fn display_kimi_name(id: &str) -> String {
    if let Some(cached) = cached_models().iter().find(|m| m.id == id) {
        if !cached.display_name.trim().is_empty() {
            return cached.display_name.clone();
        }
    }
    prettify_kimi_id(id)
}

fn prettify_kimi_id(id: &str) -> String {
    if id.is_empty() {
        return id.to_string();
    }
    let mut parts: Vec<String> = Vec::new();
    for raw in id.split('-') {
        if raw.is_empty() {
            continue;
        }
        let lower = raw.to_ascii_lowercase();
        let shaped = match lower.as_str() {
            "kimi" => "Kimi".to_string(),
            "k2" => "K2".to_string(),
            "k1" => "K1".to_string(),
            "moonshot" => "Moonshot".to_string(),
            "preview" => "(preview)".to_string(),
            "thinking" => "Thinking".to_string(),
            "turbo" => "Turbo".to_string(),
            "mini" => "Mini".to_string(),
            other => {
                let is_digits = other.chars().all(|c| c.is_ascii_digit());
                if is_digits {
                    other.to_string()
                } else {
                    let mut cs = other.chars();
                    match cs.next() {
                        Some(first) => {
                            let rest: String = cs.collect();
                            format!("{}{}", first.to_ascii_uppercase(), rest)
                        }
                        None => String::new(),
                    }
                }
            }
        };
        if !shaped.is_empty() {
            parts.push(shaped);
        }
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_is_empty_before_fetch() {
        assert!(cached_models().is_empty());
    }

    #[test]
    fn kimi_model_parses_minimal_shape() {
        let j = serde_json::json!({
            "id": "kimi-k2-0905-preview"
        });
        let m: KimiModel = serde_json::from_value(j).unwrap();
        assert_eq!(m.id, "kimi-k2-0905-preview");
        assert_eq!(m.display_name, "");
        assert_eq!(m.context_length, 0);
        assert!(!m.supports_reasoning);
    }

    #[test]
    fn kimi_model_parses_full_shape() {
        let j = serde_json::json!({
            "id": "kimi-k2-turbo-preview",
            "display_name": "Kimi K2 Turbo (preview)",
            "context_length": 262144,
            "supports_reasoning": true,
            "supports_image_in": true,
            "supports_video_in": false
        });
        let m: KimiModel = serde_json::from_value(j).unwrap();
        assert_eq!(m.id, "kimi-k2-turbo-preview");
        assert_eq!(m.context_length, 262144);
        assert!(m.supports_reasoning);
        assert!(m.supports_image_in);
        assert!(!m.supports_video_in);
    }

    #[test]
    fn k2_prefix_implies_thinking_even_without_flag() {
        let m = KimiModel {
            id: "kimi-k2-0905-preview".into(),
            display_name: String::new(),
            context_length: 0,
            supports_reasoning: false,
            supports_image_in: false,
            supports_video_in: false,
        };
        assert!(m.has_thinking(), "kimi-cli treats any kimi-k2* as thinking-capable");
    }

    #[test]
    fn thinking_in_id_sets_always_thinking() {
        let m = KimiModel {
            id: "kimi-k2-thinking".into(),
            display_name: String::new(),
            context_length: 0,
            supports_reasoning: false,
            supports_image_in: false,
            supports_video_in: false,
        };
        assert!(m.always_thinking());
    }

    #[test]
    fn display_kimi_name_prettifies_when_api_omits_label() {
        // No cache hit → fallback prettifier — server may omit display_name.
        assert_eq!(display_kimi_name("kimi-k2-turbo-preview"), "Kimi K2 Turbo (preview)");
        assert_eq!(display_kimi_name("kimi-k2-thinking"), "Kimi K2 Thinking");
        assert_eq!(display_kimi_name("kimi-k2-0905-preview"), "Kimi K2 0905 (preview)");
        assert_eq!(display_kimi_name("kimi-latest"), "Kimi Latest");
    }

    #[test]
    fn display_kimi_name_falls_back_to_raw_id_on_empty() {
        assert_eq!(display_kimi_name(""), "");
    }
}
