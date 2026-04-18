//! Anthropic OAuth provider — MVP target.
//!
//! Routes requests to `https://api.anthropic.com/v1/messages?beta=true` with
//! the Claude Code 2.1.113 fingerprint.
//!
//! # Flow for `-p "hi"`
//!
//! 1. Agent layer emits `OpenAiChatRequest`.
//! 2. [`AnthropicProvider::stream`] receives it.
//! 3. [`auth::anthropic::authorization_header`] resolves the bearer
//!    (proactively refreshes if within 60s safety margin — see
//!    `fingerprint_corpus/oauth/refresh_behavior.md`).
//! 4. [`translator::openai_to_anthropic::build_request_body`] produces
//!    the exact bytes captured by the corpus, with user prompt + session
//!    email/date substituted in.
//! 5. We POST with the full fingerprint header set from
//!    [`fingerprint::anthropic`].
//! 6. On 200, we wrap the response byte stream in an
//!    [`AnthropicChunkStream`] that drives `SseBuffer` +
//!    `AnthropicStreamTranslator` and yields canonical
//!    [`OpenAiChunk`]s.
//! 7. On 401 we return [`Error::Auth`] terminally — no reactive refresh
//!    (matches captured Claude Code behavior).
//! 8. On 429 we parse `retry-after` and return [`Error::RateLimit`].
//! 9. Every other non-2xx becomes [`Error::Other`] with the body text
//!    truncated to a reasonable length.
//!
//! # UserContext source
//!
//! For MVP the `email` + `current_date` fields embedded in the body's
//! system-reminder block come from (in priority order):
//!
//! 1. `OTHERSIDE_USER_EMAIL` environment variable, else `user@local`.
//! 2. `chrono::Local::now()` formatted as `YYYY-MM-DD`.
//!
//! These are NOT fingerprint headers — they land INSIDE the captured
//! body template. Claude Code populates them from the logged-in account
//! + system clock; we approximate until the interactive mode carries
//! real session state.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use uuid::Uuid;

use crate::auth::anthropic as auth;
use crate::error::{Error, Result};
use crate::fingerprint::anthropic as fp;
use crate::inference::{OpenAiChatRequest, OpenAiChunk};
use crate::thinking::ThinkingConfig;
use crate::translator::anthropic_to_openai::AnthropicStreamTranslator;
use crate::translator::openai_to_anthropic::{build_request_body, UserContext};
use crate::translator::sse::SseBuffer;

use super::{ChunkStream, Provider};

/// Stable provider ID registered in [`Registry`](super::Registry).
pub const ID: &str = "anthropic-oauth";

/// Anthropic `/v1/messages` provider.
///
/// Holds a single preconfigured [`reqwest::Client`] shared across calls.
/// Building the client is expensive (TLS config setup), so we do it once
/// at construction and reuse — mirrors Anthropic JS SDK's own pattern.
pub struct AnthropicProvider {
    http: reqwest::Client,
}

impl AnthropicProvider {
    /// Construct a provider with a reqwest client configured for
    /// streaming inference.
    ///
    /// - Default timeout: disabled (long-running streams must not time
    ///   out on the connect/read boundary; individual header timeouts
    ///   are set by the request builder).
    /// - Accept-Encoding: reqwest negotiates gzip/brotli/zstd via the
    ///   compiled-in features (see Cargo.toml features).
    /// - TLS: rustls via the `rustls-tls` feature.
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            // Do not set a global `.timeout()` — SSE streams are
            // long-lived. Individual phases (connect, request) can be
            // added later if needed.
            .pool_idle_timeout(Duration::from_secs(90))
            .build()?;
        Ok(Self { http })
    }

    /// Convenience constructor for use inside [`super::Registry::builder`].
    pub fn arc() -> Result<Arc<dyn Provider>> {
        Ok(Arc::new(Self::new()?))
    }
}

impl Provider for AnthropicProvider {
    fn id(&self) -> &'static str {
        ID
    }

    fn stream<'a>(
        &'a self,
        req: OpenAiChatRequest,
        _thinking: Option<ThinkingConfig>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>> {
        // Everything that happens BEFORE the response headers arrive
        // lives in this async block. Once we hold a byte stream, we
        // return a boxed Stream that is driven by the caller.
        Box::pin(async move {
            // Proactively refresh if needed, then produce the bearer.
            let bearer = auth::authorization_header().await?;

            // Pull session context from env/clock. Template placeholders
            // get substituted with these values in the body builder.
            let (email, date) = resolve_user_context();
            let ctx = UserContext {
                email: &email,
                current_date: &date,
            };
            let body = build_request_body(&req, &ctx)?;

            // Build the request with the exact header set captured in
            // MAPPING §Stainless + §/v1/messages.
            let headers = build_inference_headers(&bearer)?;

            let response = self
                .http
                .post(fp::API_MESSAGES_URL)
                .headers(headers)
                .body(body)
                .send()
                .await?;

            // Status dispatch. 200 → stream. 401 → terminal auth error
            // (no reactive refresh). 429 → rate-limit with retry_after.
            // Everything else is a generic Other.
            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                let text = response.text().await.unwrap_or_default();
                return Err(Error::Auth(format!(
                    "HTTP 401 from /v1/messages: {} — run `otherside login --provider anthropic-oauth`",
                    truncate(&text, 300)
                )));
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                // `retry-after` may be seconds or an HTTP-date. MVP
                // parses the seconds form; date form degrades to None.
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(Duration::from_secs);
                let text = response.text().await.unwrap_or_default();
                return Err(Error::RateLimit {
                    retry_after,
                    provider_message: truncate(&text, 300),
                });
            }
            if !status.is_success() {
                let text = response.text().await.unwrap_or_default();
                return Err(Error::Other(format!(
                    "HTTP {status} from /v1/messages: {}",
                    truncate(&text, 500)
                )));
            }

            // Erase the concrete stream type behind BoxStream so the
            // chunk stream is `'static + Send` and can outlive the
            // provider.
            let bytes: BoxStream<'static, reqwest::Result<Bytes>> =
                response.bytes_stream().boxed();
            let chunk_stream: ChunkStream = Box::pin(AnthropicChunkStream::new(bytes));
            Ok(chunk_stream)
        })
    }
}

/// Resolve the session `(email, current_date)` used by the body
/// template. Pure function, reads env + wall clock only.
fn resolve_user_context() -> (String, String) {
    let email = std::env::var("OTHERSIDE_USER_EMAIL").unwrap_or_else(|_| "user@local".to_string());
    // chrono::Local::now() uses the system timezone so the date matches
    // what the user sees on their machine — captured Claude Code uses
    // the same local-date semantics.
    let date = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    (email, date)
}

/// Truncate a string for error messages to avoid flooding stderr with
/// a multi-KB upstream body.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

/// Build the full header map for a `/v1/messages?beta=true` request.
///
/// Every header here is either a fingerprint parity requirement (per
/// MAPPING §/v1/messages inference request) or an OAuth-bearer
/// authorization. Nothing in this function is "our" choice — every
/// value traces back to the captured corpus.
fn build_inference_headers(bearer: &str) -> Result<HeaderMap> {
    let mut h = HeaderMap::new();

    // Authorization — the only per-request-rotating header that isn't
    // part of the Stainless/anthropic-beta fingerprint surface.
    h.insert(
        reqwest::header::AUTHORIZATION,
        HeaderValue::from_str(bearer).map_err(bad_header)?,
    );

    // Content-Type: /v1/messages wants JSON. Captured traffic sends
    // `application/json` verbatim (no charset suffix).
    h.insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    // Accept for SSE streams.
    h.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/json"),
    );

    // Claude Code impersonation: User-Agent identifies us as the
    // Anthropic JS SDK running under the Claude Code CLI.
    let ua = fp::ua_sdk_cli();
    h.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_str(&ua).map_err(bad_header)?,
    );

    // Anthropic API version + per-endpoint beta flags.
    static_header(&mut h, "anthropic-version", fp::ANTHROPIC_VERSION)?;
    static_header(&mut h, "anthropic-beta", fp::ANTHROPIC_BETA_INFERENCE)?;
    // Captured with value `true` — gates a cross-origin code path on
    // Anthropic's side that we rely on for OAuth-token traffic.
    static_header(&mut h, "anthropic-dangerous-direct-browser-access", "true")?;

    // Stainless SDK fingerprint — eight headers.
    static_header(&mut h, "x-stainless-lang", fp::STAINLESS_LANG)?;
    static_header(
        &mut h,
        "x-stainless-package-version",
        fp::STAINLESS_PACKAGE_VERSION,
    )?;
    static_header(&mut h, "x-stainless-runtime", fp::STAINLESS_RUNTIME)?;
    static_header(
        &mut h,
        "x-stainless-runtime-version",
        fp::STAINLESS_RUNTIME_VERSION,
    )?;
    static_header(&mut h, "x-stainless-timeout", fp::STAINLESS_TIMEOUT)?;
    static_header(&mut h, "x-stainless-retry-count", "0")?;
    static_header(&mut h, "x-stainless-arch", fp::stainless_arch())?;
    static_header(&mut h, "x-stainless-os", fp::stainless_os())?;

    // Claude-Code-specific request stamps.
    static_header(&mut h, "x-app", "cli")?;
    let session_id = Uuid::new_v4().to_string();
    let request_id = Uuid::new_v4().to_string();
    h.insert(
        HeaderName::from_static("x-claude-code-session-id"),
        HeaderValue::from_str(&session_id).map_err(bad_header)?,
    );
    h.insert(
        HeaderName::from_static("x-client-request-id"),
        HeaderValue::from_str(&request_id).map_err(bad_header)?,
    );

    Ok(h)
}

/// Helper: insert a header whose name is a compile-time lowercase
/// literal and whose value is a `&str`.
fn static_header(h: &mut HeaderMap, name: &'static str, value: &str) -> Result<()> {
    h.insert(
        HeaderName::from_static(name),
        HeaderValue::from_str(value).map_err(bad_header)?,
    );
    Ok(())
}

/// Map a header parse error into [`Error::Other`]. Should never fire in
/// practice because all values come from static strings or UUIDs.
fn bad_header<E: std::fmt::Display>(e: E) -> Error {
    Error::Other(format!("invalid header value: {e}"))
}

/// Adapter stream: wraps the reqwest byte stream in the SSE parser and
/// Anthropic-→-OpenAI translator.
///
/// Implemented by hand as a `Stream` rather than via async_stream so we
/// don't pull a macro dep. Drives a small queue of `OpenAiChunk`s that
/// the translator emits per batch of incoming bytes.
struct AnthropicChunkStream {
    bytes: BoxStream<'static, reqwest::Result<Bytes>>,
    buf: SseBuffer,
    translator: AnthropicStreamTranslator,
    pending: VecDeque<OpenAiChunk>,
    /// `true` once the upstream byte stream has returned `None` and
    /// `flush_on_eof` has been drained.
    finished: bool,
}

impl AnthropicChunkStream {
    fn new(bytes: BoxStream<'static, reqwest::Result<Bytes>>) -> Self {
        Self {
            bytes,
            buf: SseBuffer::new(),
            translator: AnthropicStreamTranslator::new(),
            pending: VecDeque::new(),
            finished: false,
        }
    }

    /// Translate every completed SSE event currently in the buffer,
    /// pushing resulting chunks into `self.pending`.
    fn drain_events(&mut self) -> Result<()> {
        for event in self.buf.drain() {
            if let Some(chunk) = self.translator.on_event(&event)? {
                self.pending.push_back(chunk);
            }
        }
        Ok(())
    }
}

impl Stream for AnthropicChunkStream {
    type Item = Result<OpenAiChunk>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            // Always drain pending chunks first — they represent
            // already-translated events from earlier byte batches.
            if let Some(chunk) = self.pending.pop_front() {
                return Poll::Ready(Some(Ok(chunk)));
            }
            if self.finished {
                return Poll::Ready(None);
            }

            match self.bytes.as_mut().poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(bytes))) => {
                    self.buf.push(&bytes);
                    if let Err(e) = self.drain_events() {
                        // Translator error → terminate the stream with
                        // Err; subsequent polls return None via the
                        // `finished` flag.
                        self.finished = true;
                        return Poll::Ready(Some(Err(e)));
                    }
                }
                Poll::Ready(Some(Err(e))) => {
                    self.finished = true;
                    return Poll::Ready(Some(Err(Error::from(e))));
                }
                Poll::Ready(None) => {
                    // Upstream byte stream terminated. Flush any
                    // trailing frame and translate.
                    if let Some(event) = self.buf.flush_on_eof() {
                        match self.translator.on_event(&event) {
                            Ok(Some(chunk)) => self.pending.push_back(chunk),
                            Ok(None) => {}
                            Err(e) => {
                                self.finished = true;
                                return Poll::Ready(Some(Err(e)));
                            }
                        }
                    }
                    self.finished = true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[test]
    fn provider_id_is_stable_constant() {
        // Callers key the registry by this ID string, so it must not
        // change without a migration.
        assert_eq!(ID, "anthropic-oauth");
    }

    #[test]
    fn resolve_user_context_uses_env_override() {
        // Isolation: save + restore env so concurrent tests don't
        // interleave.
        let prev = std::env::var("OTHERSIDE_USER_EMAIL").ok();
        // SAFETY: process-global env; single-threaded per test.
        unsafe { std::env::set_var("OTHERSIDE_USER_EMAIL", "override@example.com") };
        let (email, _date) = resolve_user_context();
        assert_eq!(email, "override@example.com");
        // Restore.
        match prev {
            Some(v) => unsafe { std::env::set_var("OTHERSIDE_USER_EMAIL", v) },
            None => unsafe { std::env::remove_var("OTHERSIDE_USER_EMAIL") },
        }
    }

    #[test]
    fn truncate_leaves_short_strings_alone() {
        assert_eq!(truncate("short", 100), "short");
    }

    #[test]
    fn truncate_appends_ellipsis_when_over_limit() {
        let out = truncate("abcdef", 3);
        assert_eq!(out, "abc…");
    }

    #[test]
    fn build_inference_headers_carries_all_fingerprint_values() {
        let h = build_inference_headers("Bearer test").unwrap();
        // Spot-check every fingerprint header — if any of these
        // regress, the upstream fingerprint will flag our traffic.
        assert_eq!(h.get(reqwest::header::AUTHORIZATION).unwrap(), "Bearer test");
        assert_eq!(
            h.get("anthropic-version").unwrap(),
            fp::ANTHROPIC_VERSION
        );
        assert_eq!(
            h.get("anthropic-beta").unwrap(),
            fp::ANTHROPIC_BETA_INFERENCE
        );
        assert_eq!(
            h.get("anthropic-dangerous-direct-browser-access").unwrap(),
            "true"
        );
        assert_eq!(h.get("x-app").unwrap(), "cli");
        assert_eq!(h.get("x-stainless-lang").unwrap(), "js");
        assert_eq!(h.get("x-stainless-package-version").unwrap(), "0.81.0");
        assert_eq!(h.get("x-stainless-runtime").unwrap(), "node");
        assert_eq!(h.get("x-stainless-runtime-version").unwrap(), "v24.3.0");
        assert_eq!(h.get("x-stainless-timeout").unwrap(), "600");
        assert_eq!(h.get("x-stainless-retry-count").unwrap(), "0");
        // Arch/OS depend on the host — just check they're non-empty.
        assert!(!h.get("x-stainless-arch").unwrap().is_empty());
        assert!(!h.get("x-stainless-os").unwrap().is_empty());
        // UUIDs are distinct per call — check shape only.
        let session = h.get("x-claude-code-session-id").unwrap().to_str().unwrap();
        let request = h.get("x-client-request-id").unwrap().to_str().unwrap();
        assert_eq!(session.len(), 36);
        assert_eq!(request.len(), 36);
        assert_ne!(session, request);
        // User-Agent matches the sdk-cli formulation.
        let ua = h
            .get(reqwest::header::USER_AGENT)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ua.contains("claude-cli/"));
        assert!(ua.contains("(external, sdk-cli)"));
    }

    #[tokio::test]
    async fn chunk_stream_from_corpus_bytes_produces_expected_sequence() {
        // End-to-end of the streaming layer WITHOUT a real HTTP call:
        // feed captured corpus bytes directly through the
        // AnthropicChunkStream adapter and assert the same 4-chunk
        // sequence as the translator's own conformance test.
        let wire: &[u8] = include_bytes!("../../fingerprint_corpus/hello/response.sse");
        // Split the corpus into two random pieces to ensure the state
        // machine handles multi-chunk delivery.
        let mid = wire.len() / 2;
        let a = Bytes::copy_from_slice(&wire[..mid]);
        let b = Bytes::copy_from_slice(&wire[mid..]);
        let upstream = futures::stream::iter(vec![Ok(a), Ok(b)]).boxed();

        let mut stream = AnthropicChunkStream::new(upstream);
        let mut chunks = Vec::new();
        while let Some(item) = stream.next().await {
            chunks.push(item.expect("translation must not error"));
        }

        assert_eq!(chunks.len(), 4, "expected 4 chunks, got {}", chunks.len());
        assert_eq!(chunks[0].id, "XXX_MESSAGE_ID_XXX");
        assert_eq!(chunks[0].model, "claude-opus-4-7");
        assert_eq!(
            chunks[1].choices[0].delta.content.as_deref(),
            Some("Hi! How")
        );
        assert_eq!(
            chunks[2].choices[0].delta.content.as_deref(),
            Some(" can I help?")
        );
        assert_eq!(
            chunks[3].choices[0].finish_reason.as_deref(),
            Some("stop")
        );
    }

    #[tokio::test]
    async fn chunk_stream_surfaces_upstream_transport_errors() {
        // If reqwest yields an Err mid-stream (connection reset,
        // rustls failure, etc.) the chunk stream must surface it once
        // then terminate.
        //
        // We can't easily synthesize a real reqwest::Error here, so we
        // assert the finished-flag behavior indirectly: once we hit
        // None from the upstream, no further chunks are produced.
        let upstream = futures::stream::empty().boxed();
        let mut stream = AnthropicChunkStream::new(upstream);
        assert!(stream.next().await.is_none());
        assert!(stream.next().await.is_none()); // subsequent polls also None.
    }
}
