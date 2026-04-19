//! `WebSearch` — query the web, exposed as a deferred tool.
//!
//! # Status
//!
//! Schema is **otherside-native** — synthesized from upstream's Zod at
//! `tools/WebSearchTool/WebSearchTool.ts:25-37`. Name + field shapes
//! mirror upstream; description prose is rewritten for R-103 identity-
//! zone discipline (no upstream product-name strings in the identity
//! zone). When a live `ToolSearch` capture records a real schema for
//! `WebSearch`, `TOOL_WEB_SEARCH_JSON` swaps byte-verbatim.
//!
//! # Backend selection — runtime, not compile-time
//!
//! Two backends share one trait. Selection happens on every call based
//! on env presence, NOT on a cargo feature:
//!
//! 1. [`GoogleCseBackend`] — active when BOTH
//!    `OTHERSIDE_GOOGLE_CSE_KEY` + `OTHERSIDE_GOOGLE_CSE_CX` are set.
//!    Issues a GET to Google's Custom Search JSON API and maps `items[]`
//!    to `{title, url, snippet}`. Free tier: 100 queries / day.
//! 2. [`UnavailableBackend`] — default. Returns a structured stub that
//!    names the two env vars needed to enable a real backend. Keeps the
//!    tool resolvable so the model can plan calls without tripping
//!    `ToolError::Unsupported`.
//!
//! Rationale vs. a `cfg`-gated backend: runtime detection means one
//! binary works both off-the-shelf (stub path) and for users who export
//! the env vars — no recompile, no feature matrix. §4 simplicity.
//!
//! # Deferred (see openspec/changes/019 §Out)
//!
//! - Secondary-model summarization. Raw `{title, url, snippet}` hits
//!   surface directly; the main-loop model handles synthesis.
//! - Streaming progress events (upstream emits `search-progress-N`).
//! - Permission gating — dispatcher signature lacks `PermissionContext`.
//! - Server-side `web_search_20250305` beta tool delegation — upstream-
//!   only path; otherside uses client-side backends instead.
//!
//! Zone: identity — R-103 applies. No upstream product-name strings in
//! identifiers or copy.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::ToolError;

/// Env var — Google CSE API key. Both this AND [`ENV_GOOGLE_CSE_CX`]
/// must be present to activate [`GoogleCseBackend`].
const ENV_GOOGLE_CSE_KEY: &str = "OTHERSIDE_GOOGLE_CSE_KEY";

/// Env var — Google CSE custom-search-engine id (`cx`).
const ENV_GOOGLE_CSE_CX: &str = "OTHERSIDE_GOOGLE_CSE_CX";

/// Request timeout for the search backend. Aligned with the WebFetch
/// budget; keeps a stalled CSE from pinning the agent loop.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Max hits returned by Google CSE in a single call. Free tier caps at
/// 10; asking for more errors out.
const DEFAULT_RESULT_COUNT: u8 = 10;

/// Single result row. Upstream's Zod shape is `{title, url}`; we add
/// `snippet` because Google CSE returns it and it's cheap context for
/// the model. Field order matches the wire JSON (preserve_order).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

impl SearchResult {
    fn to_json(&self) -> Value {
        json!({
            "title": self.title,
            "url": self.url,
            "snippet": self.snippet,
        })
    }
}

/// Pluggable search backend. Runtime-selected per call; see module docs.
trait WebSearchBackend {
    fn search(&self, query: &str) -> Result<Vec<SearchResult>, ToolError>;
}

/// Default backend when the Google CSE env vars are not set. Returns a
/// structured stub that tells the caller (model + human) how to enable
/// a real backend. Never touches the network.
struct UnavailableBackend;

impl WebSearchBackend for UnavailableBackend {
    fn search(&self, _query: &str) -> Result<Vec<SearchResult>, ToolError> {
        // Intentionally empty — the dispatcher materializes the stub
        // marker string into the `results` array so the model sees the
        // same `{query, results, durationSeconds}` contract regardless
        // of backend state.
        Ok(Vec::new())
    }
}

/// Google Custom Search JSON API backend. Active when both env vars are
/// set. Free tier is 100 queries / day across the whole Google account.
struct GoogleCseBackend {
    key: String,
    cx: String,
}

impl GoogleCseBackend {
    /// Attempt to construct the backend from the process env. Returns
    /// `None` when either env var is missing or empty — caller falls
    /// through to [`UnavailableBackend`] without erroring.
    fn from_env() -> Option<Self> {
        let key = std::env::var(ENV_GOOGLE_CSE_KEY).ok()?;
        let cx = std::env::var(ENV_GOOGLE_CSE_CX).ok()?;
        if key.is_empty() || cx.is_empty() {
            return None;
        }
        Some(Self { key, cx })
    }

    /// Build the request URL. Extracted so tests can assert the shape
    /// without hitting the network. Per Google CSE docs, `q` goes in
    /// the query string; `num` caps at 10 on the free tier.
    fn build_url(&self, query: &str) -> Result<url::Url, ToolError> {
        let mut u = url::Url::parse("https://www.googleapis.com/customsearch/v1")
            .map_err(|e| ToolError::InvalidArgs(format!("cse base url parse failed: {e}")))?;
        u.query_pairs_mut()
            .append_pair("key", &self.key)
            .append_pair("cx", &self.cx)
            .append_pair("num", &DEFAULT_RESULT_COUNT.to_string())
            .append_pair("q", query);
        Ok(u)
    }
}

/// Minimal subset of Google CSE's JSON response. We only care about the
/// hits — quota metadata, promotions, spell-corrections are ignored for
/// now (the model doesn't need them and the fewer fields we parse, the
/// less brittle the contract).
#[derive(Debug, Deserialize)]
struct CseResponse {
    #[serde(default)]
    items: Vec<CseItem>,
}

#[derive(Debug, Deserialize)]
struct CseItem {
    #[serde(default)]
    title: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    snippet: String,
}

impl WebSearchBackend for GoogleCseBackend {
    fn search(&self, query: &str) -> Result<Vec<SearchResult>, ToolError> {
        let url = self.build_url(query)?;

        // reqwest is async; dispatcher is sync. Reuse the WebFetch
        // pattern — block_in_place lets the multi-thread runtime keep
        // scheduling other tasks during the HTTP round-trip. Matches
        // R-107 and parity with `web_fetch::web_fetch`.
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async move {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                    .build()
                    .map_err(|e| {
                        ToolError::InvalidArgs(format!("failed to build http client: {e}"))
                    })?;

                let resp = client.get(url).send().await.map_err(|e| {
                    ToolError::InvalidArgs(format!("google cse fetch failed: {e}"))
                })?;
                let status = resp.status();
                if !status.is_success() {
                    // Surface the server-side error body when we can —
                    // most CSE 4xx responses carry a JSON `error.message`
                    // that's useful for diagnosis. On parse failure fall
                    // back to the status line alone.
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ToolError::InvalidArgs(format!(
                        "google cse returned http {}: {}",
                        status.as_u16(),
                        body
                    )));
                }

                let parsed: CseResponse = resp.json().await.map_err(|e| {
                    ToolError::InvalidArgs(format!("failed to parse cse response: {e}"))
                })?;
                Ok(parse_cse_items(parsed))
            })
        })
    }
}

/// Convert a parsed CSE response into `SearchResult`s. Extracted so the
/// parser can be unit-tested without any async plumbing.
fn parse_cse_items(resp: CseResponse) -> Vec<SearchResult> {
    resp.items
        .into_iter()
        .map(|it| SearchResult {
            title: it.title,
            url: it.link,
            snippet: it.snippet,
        })
        .collect()
}

/// Parse the optional `allowed_domains` / `blocked_domains` args into
/// `Vec<String>`. Non-array values are rejected with a clear message so
/// the model sees a structured error instead of a silent drop.
fn parse_domain_list(args: &Value, field: &str) -> Result<Vec<String>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(xs)) => xs
            .iter()
            .map(|v| {
                v.as_str().map(str::to_string).ok_or_else(|| {
                    ToolError::InvalidArgs(format!("{field}[] must contain only strings"))
                })
            })
            .collect(),
        Some(_) => Err(ToolError::InvalidArgs(format!(
            "{field} must be an array of strings"
        ))),
    }
}

/// Drop results that fail the allow-list or match the block-list.
/// Filtering is host-based — subdomain matches count (e.g. allow
/// `wikipedia.org` keeps `en.wikipedia.org`). Both lists empty → no-op.
fn filter_by_domain(
    results: Vec<SearchResult>,
    allowed: &[String],
    blocked: &[String],
) -> Vec<SearchResult> {
    results
        .into_iter()
        .filter(|r| {
            let Ok(parsed) = url::Url::parse(&r.url) else {
                // Malformed URL — conservatively drop it.
                return false;
            };
            let Some(host) = parsed.host_str() else {
                return false;
            };
            let host_lower = host.to_ascii_lowercase();

            if !allowed.is_empty() {
                let ok = allowed
                    .iter()
                    .any(|d| matches_host(&host_lower, &d.to_ascii_lowercase()));
                if !ok {
                    return false;
                }
            }
            if !blocked.is_empty() {
                let bad = blocked
                    .iter()
                    .any(|d| matches_host(&host_lower, &d.to_ascii_lowercase()));
                if bad {
                    return false;
                }
            }
            true
        })
        .collect()
}

/// Host-match predicate used by the domain filter. True when `host` is
/// equal to `needle` or ends with `.<needle>` — lets callers pass a
/// root domain and cover every subdomain automatically.
fn matches_host(host: &str, needle: &str) -> bool {
    host == needle || host.ends_with(&format!(".{needle}"))
}

/// Pick the active backend. Runtime-detected; see module docs. Returned
/// as a trait object so the dispatcher path is backend-agnostic.
fn select_backend() -> Box<dyn WebSearchBackend> {
    if let Some(google) = GoogleCseBackend::from_env() {
        Box::new(google)
    } else {
        Box::new(UnavailableBackend)
    }
}

/// Marker string the unavailable-backend stub drops into the results
/// array. Tests and integrations grep for the `web_search_unavailable`
/// prefix to detect the stub path; the trailing sentence names both
/// env vars so humans see the remediation inline.
const UNAVAILABLE_MARKER: &str = "web_search_unavailable - configure \
    OTHERSIDE_GOOGLE_CSE_KEY + OTHERSIDE_GOOGLE_CSE_CX to enable";

/// Dispatch the `WebSearch` tool. Input is JSON per
/// [`TOOL_WEB_SEARCH_JSON`]; output is
/// `{query, results, durationSeconds}` matching upstream's Zod shape.
/// Results entries are either `SearchResult` objects or plain strings
/// (the stub marker lands as a string entry).
pub fn web_search(args: &Value) -> Result<Value, ToolError> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("query is required".into()))?
        .to_string();
    if query.trim().is_empty() {
        return Err(ToolError::InvalidArgs("query must not be empty".into()));
    }

    let allowed = parse_domain_list(args, "allowed_domains")?;
    let blocked = parse_domain_list(args, "blocked_domains")?;
    if !allowed.is_empty() && !blocked.is_empty() {
        // Mirrors upstream's `validateInput` — both lists together are
        // ambiguous. Forcing the caller to pick one prevents the "why
        // did my allow-list drop results that weren't on my block-list"
        // support surface.
        return Err(ToolError::InvalidArgs(
            "cannot specify both allowed_domains and blocked_domains in the same call".into(),
        ));
    }

    let backend = select_backend();
    let started = Instant::now();
    let raw = backend.search(&query)?;
    let duration_seconds = started.elapsed().as_secs_f64();

    // Unavailable-backend path: surface the marker as a string entry so
    // the results array matches upstream's `SearchResult | string` shape.
    // Any empty-hits return from a real backend also falls here, but
    // only when the backend really is UnavailableBackend — we detect by
    // presence of env vars rather than downcasting the trait object.
    let is_unavailable = GoogleCseBackend::from_env().is_none();
    let results_json: Vec<Value> = if is_unavailable {
        vec![Value::String(UNAVAILABLE_MARKER.to_string())]
    } else {
        let filtered = filter_by_domain(raw, &allowed, &blocked);
        filtered.iter().map(SearchResult::to_json).collect()
    };

    Ok(json!({
        "query": query,
        "results": results_json,
        "durationSeconds": duration_seconds,
    }))
}

/// `WebSearch` schema — otherside-native synthesis of upstream's Zod at
/// `tools/WebSearchTool/WebSearchTool.ts:25-37`. Description captures
/// the behavior guarantees without dragging in upstream prose that
/// mentions product names (R-103).
pub const TOOL_WEB_SEARCH_JSON: &str = r#"{
  "name": "WebSearch",
  "description": "Search the web and return result links. Returns up to 10 hits per call as {title, url, snippet} objects. Supports optional allowed_domains or blocked_domains filters (not both in the same call). Read-only — does not modify files. Requires OTHERSIDE_GOOGLE_CSE_KEY + OTHERSIDE_GOOGLE_CSE_CX environment variables to enable the Google Custom Search backend; without them the tool returns a structured unavailable stub so the model can still plan.",
  "input_schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "query": {
        "description": "The search query. Minimum 2 characters.",
        "type": "string",
        "minLength": 2
      },
      "allowed_domains": {
        "description": "Only include search results from these domains. Host-based match — passing a root domain covers every subdomain.",
        "type": "array",
        "items": { "type": "string" }
      },
      "blocked_domains": {
        "description": "Never include search results from these domains. Host-based match.",
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// Clear both Google CSE env vars for the duration of a test. Needed
    /// because `cargo test` inherits the real env, and a developer with
    /// valid CSE keys in their shell would otherwise trip the live path
    /// during unit tests.
    fn clear_cse_env() -> (Option<String>, Option<String>) {
        let k = std::env::var(ENV_GOOGLE_CSE_KEY).ok();
        let c = std::env::var(ENV_GOOGLE_CSE_CX).ok();
        std::env::remove_var(ENV_GOOGLE_CSE_KEY);
        std::env::remove_var(ENV_GOOGLE_CSE_CX);
        (k, c)
    }

    fn restore_cse_env(saved: (Option<String>, Option<String>)) {
        match saved.0 {
            Some(v) => std::env::set_var(ENV_GOOGLE_CSE_KEY, v),
            None => std::env::remove_var(ENV_GOOGLE_CSE_KEY),
        }
        match saved.1 {
            Some(v) => std::env::set_var(ENV_GOOGLE_CSE_CX, v),
            None => std::env::remove_var(ENV_GOOGLE_CSE_CX),
        }
    }

    #[test]
    fn schema_const_parses_as_json() {
        let v: Value = serde_json::from_str(TOOL_WEB_SEARCH_JSON).unwrap();
        assert_eq!(v["name"], "WebSearch");
        let required = v["input_schema"]["required"].as_array().unwrap();
        assert!(required.iter().any(|r| r == "query"));
    }

    #[test]
    fn schema_carries_domain_filter_properties() {
        let v: Value = serde_json::from_str(TOOL_WEB_SEARCH_JSON).unwrap();
        let props = v["input_schema"]["properties"].as_object().unwrap();
        assert!(props.contains_key("query"));
        assert!(props.contains_key("allowed_domains"));
        assert!(props.contains_key("blocked_domains"));
    }

    #[test]
    fn web_search_rejects_missing_query() {
        let saved = clear_cse_env();
        let err = web_search(&json!({})).unwrap_err();
        restore_cse_env(saved);
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("query")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_empty_query() {
        let saved = clear_cse_env();
        let err = web_search(&json!({"query": "   "})).unwrap_err();
        restore_cse_env(saved);
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("empty")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_both_filter_lists() {
        let saved = clear_cse_env();
        let err = web_search(&json!({
            "query": "rust async",
            "allowed_domains": ["example.com"],
            "blocked_domains": ["spam.tld"],
        }))
        .unwrap_err();
        restore_cse_env(saved);
        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("both"));
                assert!(msg.contains("allowed_domains"));
                assert!(msg.contains("blocked_domains"));
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_non_array_filter_list() {
        let saved = clear_cse_env();
        let err = web_search(&json!({
            "query": "rust",
            "allowed_domains": "example.com",
        }))
        .unwrap_err();
        restore_cse_env(saved);
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("allowed_domains")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn web_search_rejects_non_string_filter_entry() {
        let saved = clear_cse_env();
        let err = web_search(&json!({
            "query": "rust",
            "blocked_domains": [42],
        }))
        .unwrap_err();
        restore_cse_env(saved);
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("blocked_domains")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn unavailable_backend_stub_without_env() {
        let saved = clear_cse_env();
        let out = web_search(&json!({"query": "rust ownership"})).unwrap();
        restore_cse_env(saved);

        assert_eq!(out["query"], "rust ownership");
        let results = out["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        let marker = results[0].as_str().unwrap();
        assert!(marker.starts_with("web_search_unavailable"));
        assert!(marker.contains("OTHERSIDE_GOOGLE_CSE_KEY"));
        assert!(marker.contains("OTHERSIDE_GOOGLE_CSE_CX"));
        assert!(out["durationSeconds"].is_number());
    }

    #[test]
    fn unavailable_backend_when_only_key_set() {
        // Partial env — still unavailable. Matches the `from_env()`
        // invariant that BOTH vars are required.
        let saved = clear_cse_env();
        std::env::set_var(ENV_GOOGLE_CSE_KEY, "stub-key-only");
        let out = web_search(&json!({"query": "rust ownership"})).unwrap();
        std::env::remove_var(ENV_GOOGLE_CSE_KEY);
        restore_cse_env(saved);

        let results = out["results"].as_array().unwrap();
        let marker = results[0].as_str().unwrap();
        assert!(marker.starts_with("web_search_unavailable"));
    }

    #[test]
    fn google_cse_build_url_includes_required_params() {
        let backend = GoogleCseBackend {
            key: "K".into(),
            cx: "C".into(),
        };
        let u = backend.build_url("rust ownership").unwrap();
        let pairs: Vec<(String, String)> = u
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert!(pairs.iter().any(|(k, v)| k == "key" && v == "K"));
        assert!(pairs.iter().any(|(k, v)| k == "cx" && v == "C"));
        assert!(pairs.iter().any(|(k, v)| k == "q" && v == "rust ownership"));
        assert!(pairs.iter().any(|(k, _)| k == "num"));
        assert_eq!(u.host_str(), Some("www.googleapis.com"));
        assert_eq!(u.path(), "/customsearch/v1");
    }

    #[test]
    fn parse_cse_items_maps_fields() {
        let raw = json!({
            "items": [
                {"title": "A", "link": "https://a.example/x", "snippet": "aa"},
                {"title": "B", "link": "https://b.example/y", "snippet": "bb"},
            ]
        });
        let parsed: CseResponse = serde_json::from_value(raw).unwrap();
        let hits = parse_cse_items(parsed);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "A");
        assert_eq!(hits[0].url, "https://a.example/x");
        assert_eq!(hits[0].snippet, "aa");
        assert_eq!(hits[1].url, "https://b.example/y");
    }

    #[test]
    fn parse_cse_items_tolerates_missing_fields() {
        // Google occasionally omits `snippet` on very-short results.
        // Default to empty strings rather than erroring.
        let raw = json!({"items": [{"title": "T"}]});
        let parsed: CseResponse = serde_json::from_value(raw).unwrap();
        let hits = parse_cse_items(parsed);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "T");
        assert_eq!(hits[0].url, "");
        assert_eq!(hits[0].snippet, "");
    }

    #[test]
    fn parse_cse_items_handles_empty_response() {
        let raw = json!({});
        let parsed: CseResponse = serde_json::from_value(raw).unwrap();
        let hits = parse_cse_items(parsed);
        assert!(hits.is_empty());
    }

    fn hits() -> Vec<SearchResult> {
        vec![
            SearchResult {
                title: "Wiki".into(),
                url: "https://en.wikipedia.org/wiki/Rust".into(),
                snippet: "".into(),
            },
            SearchResult {
                title: "FB".into(),
                url: "https://facebook.com/page".into(),
                snippet: "".into(),
            },
            SearchResult {
                title: "Gh".into(),
                url: "https://github.com/rust-lang/rust".into(),
                snippet: "".into(),
            },
        ]
    }

    #[test]
    fn filter_allowed_keeps_only_matching() {
        let out = filter_by_domain(hits(), &["wikipedia.org".into()], &[]);
        assert_eq!(out.len(), 1);
        assert!(out[0].url.contains("wikipedia.org"));
    }

    #[test]
    fn filter_blocked_drops_matching() {
        let out = filter_by_domain(hits(), &[], &["facebook.com".into()]);
        assert_eq!(out.len(), 2);
        assert!(!out.iter().any(|r| r.url.contains("facebook.com")));
    }

    #[test]
    fn filter_is_noop_when_both_lists_empty() {
        let out = filter_by_domain(hits(), &[], &[]);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn filter_allowed_matches_subdomain() {
        // `wikipedia.org` on allow-list should keep `en.wikipedia.org`.
        let out = filter_by_domain(hits(), &["wikipedia.org".into()], &[]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn filter_drops_malformed_url() {
        let mut h = hits();
        h.push(SearchResult {
            title: "bad".into(),
            url: "not-a-url".into(),
            snippet: "".into(),
        });
        let out = filter_by_domain(h, &[], &[]);
        // Malformed URL conservatively dropped even with empty lists.
        assert!(!out.iter().any(|r| r.url == "not-a-url"));
    }

    #[test]
    fn matches_host_exact_and_subdomain() {
        assert!(matches_host("example.com", "example.com"));
        assert!(matches_host("en.example.com", "example.com"));
        assert!(matches_host("deep.sub.example.com", "example.com"));
        assert!(!matches_host("example.com", "en.example.com"));
        assert!(!matches_host("evilexample.com", "example.com"));
    }

    #[test]
    fn select_backend_returns_unavailable_without_env() {
        let saved = clear_cse_env();
        let _backend = select_backend();
        // Can't downcast a trait object, but we can assert the
        // externally-visible behavior: unavailable marker shows up.
        let out = web_search(&json!({"query": "smoke"})).unwrap();
        restore_cse_env(saved);
        let marker = out["results"][0].as_str().unwrap();
        assert!(marker.starts_with("web_search_unavailable"));
    }
}
