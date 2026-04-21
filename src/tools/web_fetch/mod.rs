

use std::time::Duration;

use serde_json::{json, Value};

use crate::tools::ToolError;

const MAX_BODY_BYTES: usize = 1_000_000;

const REQUEST_TIMEOUT_SECS: u64 = 30;

const MAX_REDIRECTS: usize = 5;

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

pub fn web_fetch(args: &Value) -> Result<Value, ToolError> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("url is required".into()))?
        .to_string();

    let _prompt = args.get("prompt").and_then(Value::as_str).unwrap_or("");

    let parsed = url::Url::parse(&url)
        .map_err(|e| ToolError::InvalidArgs(format!("invalid url `{url}`: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ToolError::InvalidArgs(format!(
            "unsupported url scheme `{}` (only http / https)",
            parsed.scheme()
        )));
    }

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

fn html_to_markdown(html: &str) -> String {
    html2md::parse_html(html)
}

fn is_html_content_type(ct: &str) -> bool {
    let lower = ct.to_ascii_lowercase();
    lower.contains("text/html") || lower.contains("application/xhtml")
}

fn is_rejected_content_type(ct: &str) -> bool {
    let lower = ct.to_ascii_lowercase();
    REJECTED_CONTENT_TYPE_SUBSTRINGS
        .iter()
        .any(|needle| lower.contains(needle))
}

pub use crate::harness::TOOL_WEB_FETCH_JSON;

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
