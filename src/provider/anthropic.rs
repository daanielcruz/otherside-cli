

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
use crate::translator::anthropic::response::AnthropicStreamTranslator;
use crate::translator::anthropic::{build_request_body, strip_1m_suffix, UserContext};
use crate::translator::sse::SseBuffer;

use super::{ChunkStream, Provider};

pub const ID: &str = "anthropic-oauth";

pub struct AnthropicProvider {
    http: reqwest::Client,
}

impl AnthropicProvider {

    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()

            .pool_idle_timeout(Duration::from_secs(90))
            .build()?;
        Ok(Self { http })
    }

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
        mut req: OpenAiChatRequest,
        _thinking: Option<ThinkingConfig>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>> {

        Box::pin(async move {

            let (stripped_model, has_1m) = strip_1m_suffix(&req.model);
            req.model = stripped_model;

            let bearer = auth::authorization_header().await?;

            let env = crate::harness::session_env::resolve();
            let ctx = UserContext {
                email: &env.email,
                current_date: &env.current_date,
                cwd: &env.cwd,
                is_git_repo: env.is_git_repo,
                platform: &env.platform,
                shell: &env.shell,
                os_version: &env.os_version,
            };
            let body = build_request_body(&req, &ctx)?;

            let headers = build_inference_headers(&bearer, has_1m)?;

            let response = self
                .http
                .post(fp::API_MESSAGES_URL)
                .headers(headers)
                .body(body)
                .send()
                .await?;

            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                let text = response.text().await.unwrap_or_default();
                return Err(Error::Auth(format!(
                    "HTTP 401 from /v1/messages: {} — run `otherside login --provider anthropic-oauth`",
                    truncate(&text, 300)
                )));
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {

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

            let bytes: BoxStream<'static, reqwest::Result<Bytes>> =
                response.bytes_stream().boxed();
            let chunk_stream: ChunkStream = Box::pin(AnthropicChunkStream::new(bytes));
            Ok(chunk_stream)
        })
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

pub(crate) fn build_inference_headers(bearer: &str, has_1m: bool) -> Result<HeaderMap> {
    let mut h = HeaderMap::new();

    h.insert(
        reqwest::header::AUTHORIZATION,
        HeaderValue::from_str(bearer).map_err(bad_header)?,
    );

    h.insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    h.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/json"),
    );

    let ua = fp::ua_sdk_cli();
    h.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_str(&ua).map_err(bad_header)?,
    );

    static_header(&mut h, "anthropic-version", fp::ANTHROPIC_VERSION)?;

    let anthropic_beta: String = if has_1m {
        format!("{},{}", fp::ANTHROPIC_BETA_INFERENCE, fp::ANTHROPIC_BETA_CONTEXT_1M)
    } else {
        fp::ANTHROPIC_BETA_INFERENCE.to_string()
    };
    static_header(&mut h, "anthropic-beta", &anthropic_beta)?;

    static_header(&mut h, "anthropic-dangerous-direct-browser-access", "true")?;

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

fn static_header(h: &mut HeaderMap, name: &'static str, value: &str) -> Result<()> {
    h.insert(
        HeaderName::from_static(name),
        HeaderValue::from_str(value).map_err(bad_header)?,
    );
    Ok(())
}

fn bad_header<E: std::fmt::Display>(e: E) -> Error {
    Error::Header(format!("invalid header value: {e}"))
}

struct AnthropicChunkStream {
    bytes: BoxStream<'static, reqwest::Result<Bytes>>,
    buf: SseBuffer,
    translator: AnthropicStreamTranslator,
    pending: VecDeque<OpenAiChunk>,

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

            if let Some(chunk) = self.pending.pop_front() {
                tracing::trace!(
                    target: "otherside::stream",
                    hop = "provider_chunk_yield",
                    pending_after = self.pending.len(),
                    "OpenAiChunk leaving AnthropicChunkStream"
                );
                return Poll::Ready(Some(Ok(chunk)));
            }
            if self.finished {
                return Poll::Ready(None);
            }

            match self.bytes.as_mut().poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(bytes))) => {
                    tracing::trace!(
                        target: "otherside::stream",
                        hop = "provider_bytes",
                        len = bytes.len(),
                        "reqwest bytes_stream chunk"
                    );
                    self.buf.push(&bytes);
                    if let Err(e) = self.drain_events() {

                        self.finished = true;
                        return Poll::Ready(Some(Err(e)));
                    }
                }
                Poll::Ready(Some(Err(e))) => {
                    self.finished = true;
                    return Poll::Ready(Some(Err(Error::from(e))));
                }
                Poll::Ready(None) => {

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

        assert_eq!(ID, "anthropic-oauth");
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
        let h = build_inference_headers("Bearer test", false).unwrap();

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

        assert!(!h.get("x-stainless-arch").unwrap().is_empty());
        assert!(!h.get("x-stainless-os").unwrap().is_empty());

        let session = h.get("x-claude-code-session-id").unwrap().to_str().unwrap();
        let request = h.get("x-client-request-id").unwrap().to_str().unwrap();
        assert_eq!(session.len(), 36);
        assert_eq!(request.len(), 36);
        assert_ne!(session, request);

        let ua = h
            .get(reqwest::header::USER_AGENT)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ua.contains("claude-cli/"));
        assert!(ua.contains("(external, sdk-cli)"));
    }

    #[test]
    fn build_inference_headers_appends_1m_beta_when_requested() {
        let h = build_inference_headers("Bearer test", true).unwrap();
        let beta = h.get("anthropic-beta").unwrap().to_str().unwrap();
        assert!(
            beta.contains(fp::ANTHROPIC_BETA_INFERENCE),
            "original inference beta list must be preserved: {beta}"
        );
        assert!(
            beta.contains(fp::ANTHROPIC_BETA_CONTEXT_1M),
            "1M context beta must be appended: {beta}"
        );
        assert!(
            beta.ends_with(fp::ANTHROPIC_BETA_CONTEXT_1M),
            "1M flag must be last: {beta}"
        );
    }

    #[test]
    fn build_inference_headers_omits_1m_beta_by_default() {
        let h = build_inference_headers("Bearer test", false).unwrap();
        let beta = h.get("anthropic-beta").unwrap().to_str().unwrap();
        assert_eq!(beta, fp::ANTHROPIC_BETA_INFERENCE);
        assert!(!beta.contains("context-1m"));
    }

    #[tokio::test]
    async fn chunk_stream_from_corpus_bytes_produces_expected_sequence() {

        let wire: &[u8] = include_bytes!("../../../fingerprint_corpus/hello/response.sse");

        let mid = wire.len() / 2;
        let a = Bytes::copy_from_slice(&wire[..mid]);
        let b = Bytes::copy_from_slice(&wire[mid..]);
        let upstream = futures::stream::iter(vec![Ok(a), Ok(b)]).boxed();

        let mut stream = AnthropicChunkStream::new(upstream);
        let mut chunks = Vec::new();
        while let Some(item) = stream.next().await {
            chunks.push(item.expect("translation must not error"));
        }

        assert_eq!(chunks.len(), 5, "expected 5 chunks, got {}", chunks.len());
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

        assert!(chunks[3].usage.is_some());
        assert_eq!(
            chunks[4].choices[0].finish_reason.as_deref(),
            Some("stop")
        );
    }

    #[tokio::test]
    async fn chunk_stream_surfaces_upstream_transport_errors() {

        let upstream = futures::stream::empty().boxed();
        let mut stream = AnthropicChunkStream::new(upstream);
        assert!(stream.next().await.is_none());
        assert!(stream.next().await.is_none());
    }
}
