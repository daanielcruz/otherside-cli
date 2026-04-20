//! `WebFetch` — HTTP GET + HTML→markdown, exposed as a deferred tool.
//!
//! # Status
//!
//! Schema is **otherside-native** — NOT byte-fidelity against a captured
//! upstream `ToolSearch` response. Shape mirrors upstream's Zod at
//! `tools/WebFetchTool/WebFetchTool.ts:24-29`. When a live capture
//! records a real schema for `WebFetch`, `TOOL_WEB_FETCH_JSON` gets
//! swapped byte-verbatim — one-file edit.
//!
//! # Scope — first wave (019)
//!
//! - HTTP GET the URL with up to 5 redirects and a 30-second timeout.
//! - Reject obviously-binary content types (`application/octet-stream`
//!   and friends) — preserves the caller from dumping raw bytes into
//!   the context window.
//! - Cap response body at 1_000_000 bytes; oversize responses are
//!   truncated and the `truncated: true` flag surfaces that in the
//!   output JSON.
//! - Convert HTML bodies to markdown via the `html2md` crate. Non-HTML
//!   text bodies pass through unchanged.
//!
//! # Deferred (tracked in openspec/changes/019)
//!
//! - Upstream's 15-minute response cache. Shipping a crate-wide LRU +
//!   TTL plumbing is out of scope for the first wave — the round-trip
//!   cost is the caller's to manage for now.
//! - Auth — no bearer / cookie support. Private URLs return whatever
//!   the server serves unauthenticated (commonly a redirect to login).
//! - Non-text content (PDF, JSON pretty-printing, images). JSON comes
//!   through as text already; PDFs + images are rejected via the
//!   binary-content-type guard.
//! - Page JS execution. No headless browser.
//!
//! Zone: identity — R-103 identity-zone discipline applies, no upstream
//! product name strings in identifiers or copy (schemas describe
//! behavior, not provenance).

use std::time::Duration;

use serde_json::{json, Value};

use super::ToolError;

/// Cap on response body bytes. Oversize bodies are truncated at this
/// offset and flagged with `truncated: true` in the output JSON.
const MAX_BODY_BYTES: usize = 1_000_000;

/// Request timeout — matches typical CLI "fetch + summarize" budgets
/// without holding the agent loop hostage to a stalled server.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Maximum redirects followed before the request errors out. Matches
/// reqwest's default (10) trimmed down to the cap common proxies expect.
const MAX_REDIRECTS: usize = 5;

/// Content-type substrings we refuse to pipe back. Covers the common
/// binary-blob types a URL might surface; the guard is deliberately
/// loose (substring match) so variants like `application/octet-stream;
/// name=foo` still reject.
const REJECTED_CONTENT_TYPE_SUBSTRINGS: &[&str] = &[
    "application/octet-stream",
    "application/pdf",
    "image/",
    "audio/",
    "video/",
    "application/zip",
    "application/x-tar",
    "application/x-gzip",
    "application/x-7z-compressed",
];

/// Dispatch the `WebFetch` tool. Input is JSON per `TOOL_WEB_FETCH_JSON`;
/// output is a `{url, status, content_type, content, truncated}` blob.
pub fn web_fetch(args: &Value) -> Result<Value, ToolError> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("url is required".into()))?
        .to_string();

    // `prompt` is part of the documented schema so the model knows what
    // to describe wanting from the page, but this wave does not route
    // the page through a secondary summarizer. Accept and ignore for
    // schema compatibility — reading `prompt` here keeps validation
    // consistent with upstream's `z.strictObject`.
    let _prompt = args.get("prompt").and_then(Value::as_str).unwrap_or("");

    // Reject malformed URLs before we hand reqwest a guaranteed error —
    // returns a cleaner InvalidArgs message than a network-layer panic.
    let parsed = url::Url::parse(&url)
        .map_err(|e| ToolError::InvalidArgs(format!("invalid url `{url}`: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ToolError::InvalidArgs(format!(
            "unsupported url scheme `{}` (only http / https)",
            parsed.scheme()
        )));
    }

    // reqwest is async; dispatcher is sync. Wrap the blocking wait per
    // R-107 — `block_in_place` lets the multi-thread runtime keep
    // scheduling other tasks while the HTTP round-trip runs.
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async move { fetch_impl(url).await })
    })
}

async fn fetch_impl(url: String) -> Result<Value, ToolError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| ToolError::InvalidArgs(format!("failed to build http client: {e}")))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| ToolError::InvalidArgs(format!("fetch failed: {e}")))?;

    let status = resp.status();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    if !status.is_success() {
        return Err(ToolError::InvalidArgs(format!(
            "http {} for url `{}`",
            status.as_u16(),
            final_url
        )));
    }

    if is_rejected_content_type(&content_type) {
        return Err(ToolError::InvalidArgs(format!(
            "refused binary content type `{content_type}` for url `{final_url}`"
        )));
    }

    let raw = resp
        .bytes()
        .await
        .map_err(|e| ToolError::InvalidArgs(format!("failed to read response body: {e}")))?;

    let (body_bytes, truncated) = if raw.len() > MAX_BODY_BYTES {
        (raw.slice(..MAX_BODY_BYTES), true)
    } else {
        (raw, false)
    };

    let body_text = String::from_utf8_lossy(&body_bytes).into_owned();
    let content = if is_html_content_type(&content_type) {
        html_to_markdown(&body_text)
    } else {
        body_text
    };

    Ok(json!({
        "url": final_url,
        "status": status.as_u16(),
        "content_type": content_type,
        "content": content,
        "truncated": truncated,
    }))
}

/// Convert an HTML document to markdown. Delegates to the `html2md`
/// crate — covers headings, lists, links, emphasis, tables. Whitespace
/// collapse + entity decode come for free.
fn html_to_markdown(html: &str) -> String {
    html2md::parse_html(html)
}

/// Returns true when the mime looks like HTML. Matches both `text/html`
/// and `application/xhtml+xml`. Substring-based so charset parameters
/// don't defeat it.
fn is_html_content_type(ct: &str) -> bool {
    let lower = ct.to_ascii_lowercase();
    lower.contains("text/html") || lower.contains("application/xhtml")
}

/// Returns true when the mime is in the block-list. See
/// [`REJECTED_CONTENT_TYPE_SUBSTRINGS`] for the set.
fn is_rejected_content_type(ct: &str) -> bool {
    let lower = ct.to_ascii_lowercase();
    REJECTED_CONTENT_TYPE_SUBSTRINGS
        .iter()
        .any(|needle| lower.contains(needle))
}

/// `WebFetch` schema — otherside-native synthesis of upstream's Zod at
/// `tools/WebFetchTool/WebFetchTool.ts:24-29`. The description field is
/// abbreviated compared to upstream's multi-paragraph prompt so the
/// deferred-tool surface stays compact; behavior guarantees are
/// enforced by this module, not carried in description prose.
pub const TOOL_WEB_FETCH_JSON: &str =
    include_str!("../../harness_corpus/tools/WebFetch.json");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_const_parses_as_json() {
        let v: Value = serde_json::from_str(TOOL_WEB_FETCH_JSON).unwrap();
        assert_eq!(v["name"], "WebFetch");
        let required = v["input_schema"]["required"].as_array().unwrap();
        assert!(required.iter().any(|r| r == "url"));
        assert!(required.iter().any(|r| r == "prompt"));
    }

    #[test]
    fn html_to_markdown_preserves_text_content() {
        let html = "<h1>Hello</h1><p>This is <em>emphasized</em> text.</p>";
        let md = html_to_markdown(html);
        assert!(md.contains("Hello"), "markdown missing heading text: {md}");
        assert!(md.contains("emphasized"), "markdown missing body text: {md}");
    }

    #[test]
    fn html_to_markdown_renders_headings_and_links() {
        let html = r#"<h2>Docs</h2><a href="https://example.com/x">link text</a>"#;
        let md = html_to_markdown(html);
        assert!(md.contains("Docs"));
        assert!(md.contains("link text"));
    }

    #[test]
    fn is_html_content_type_matches_common_variants() {
        assert!(is_html_content_type("text/html"));
        assert!(is_html_content_type("text/html; charset=utf-8"));
        assert!(is_html_content_type("application/xhtml+xml"));
        assert!(!is_html_content_type("text/plain"));
        assert!(!is_html_content_type("application/json"));
    }

    #[test]
    fn is_rejected_content_type_covers_binary_mimes() {
        assert!(is_rejected_content_type("application/octet-stream"));
        assert!(is_rejected_content_type(
            "application/octet-stream; name=foo"
        ));
        assert!(is_rejected_content_type("application/pdf"));
        assert!(is_rejected_content_type("image/png"));
        assert!(is_rejected_content_type("video/mp4"));
        assert!(is_rejected_content_type("audio/mpeg"));
        assert!(is_rejected_content_type("application/zip"));
        assert!(!is_rejected_content_type("text/html"));
        assert!(!is_rejected_content_type("application/json"));
        assert!(!is_rejected_content_type("text/plain"));
    }

    #[test]
    fn web_fetch_rejects_missing_url() {
        let err = web_fetch(&json!({"prompt": "describe"})).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("url")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn web_fetch_rejects_malformed_url() {
        let err = web_fetch(&json!({"url": "not a url", "prompt": "x"})).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("invalid url")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn web_fetch_rejects_non_http_scheme() {
        let err = web_fetch(&json!({
            "url": "file:///etc/hosts",
            "prompt": "x",
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("scheme")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn size_cap_truncates_at_one_megabyte() {
        // Exercise the truncate path without a network: feed a body
        // larger than MAX_BODY_BYTES through the same slice logic.
        let big = vec![b'a'; MAX_BODY_BYTES + 42];
        let raw = bytes::Bytes::from(big);
        let (body_bytes, truncated) = if raw.len() > MAX_BODY_BYTES {
            (raw.slice(..MAX_BODY_BYTES), true)
        } else {
            (raw, false)
        };
        assert!(truncated);
        assert_eq!(body_bytes.len(), MAX_BODY_BYTES);
    }

    #[test]
    fn size_cap_passes_small_body_through() {
        let small = vec![b'x'; 1024];
        let raw = bytes::Bytes::from(small);
        let (body_bytes, truncated) = if raw.len() > MAX_BODY_BYTES {
            (raw.slice(..MAX_BODY_BYTES), true)
        } else {
            (raw, false)
        };
        assert!(!truncated);
        assert_eq!(body_bytes.len(), 1024);
    }
}
