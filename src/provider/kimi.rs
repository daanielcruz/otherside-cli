

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use uuid::Uuid;

use crate::auth::kimi as auth;
use crate::error::{Error, Result};
use crate::fingerprint::anthropic as anthropic_fp;
use crate::fingerprint::kimi as fp;
use crate::inference::{OpenAiChatRequest, OpenAiChunk};
use crate::thinking::ThinkingConfig;
use crate::translator::anthropic::response::AnthropicStreamTranslator;
use crate::translator::anthropic::system::SystemFlavor;
use crate::translator::anthropic::{strip_1m_suffix, UserContext};
use crate::translator::sse::SseBuffer;

use super::{ChunkStream, Provider};

pub const ID: &str = "kimi";

pub struct KimiProvider {
    http: reqwest::Client,
}

impl KimiProvider {

    pub fn new() -> Result<Self> {
        // Hard cap on total request time so a silently-stuck Kimi stream
        // can't wedge a subagent loop forever (Kimi subagent-dispatch
        // hang, 2026-04-22). 10 minutes is generous enough for long
        // reasoning turns but finite — loops now fail-fast with an
        // error the inner agent can surface instead of hanging.
        let http = reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(90))
            .timeout(Duration::from_secs(600))
            .build()?;
        Ok(Self { http })
    }

    pub fn arc() -> Result<Arc<dyn Provider>> {
        Ok(Arc::new(Self::new()?))
    }
}

impl Provider for KimiProvider {
    fn id(&self) -> &'static str {
        ID
    }

    fn stream<'a>(
        &'a self,
        mut req: OpenAiChatRequest,
        thinking: Option<ThinkingConfig>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>> {
        Box::pin(async move {

            let (stripped_model, _) = strip_1m_suffix(&req.model);
            req.model = stripped_model;

            let api_key = auth::current_api_key().await?;

            let env = crate::harness::session_env::resolve();
            let ctx = UserContext {
                email: &env.email,
                current_date: &env.current_date,
                cwd: &env.cwd,
                is_git_repo: env.is_git_repo,
                platform: &env.platform,
                shell: &env.shell,
                os_version: &env.os_version,
                memory_dir: &env.memory_dir,
                git_status: &env.git_status,
            };
            // Kimi speaks native Anthropic Messages API but is not claude-code.
            // Skip the billing header + `You are Claude Code…` opener (both
            // exclusive to Anthropic's first-party SaaS routing). Agent preamble
            // + main system prompt still flow so every operational instruction
            // lands upstream-identical.
            //
            // Kimi has no `effort` knob — the catalog gates `supported_efforts`
            // at `["auto"]` so the translator drops `output_config.effort` and
            // the `thinking` envelope block for Kimi models. The caller's
            // `thinking` param is still threaded through so future Kimi
            // thinking-capable SKUs (e.g. `kimi-k2-thinking`) pick it up
            // once catalog wires their effort support.
            let body = crate::translator::anthropic::build_request_body_with_flavor_and_thinking(
                &req,
                &ctx,
                SystemFlavor::ThirdParty,
                thinking.as_ref(),
            )?;

            let headers = build_inference_headers(&api_key)?;

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
                    "HTTP 401 from kimi /v1/messages: {} — check ${} or run `otherside login --provider kimi`",
                    truncate(&text, 300),
                    auth::ENV_VAR_CANONICAL,
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
                    "HTTP {status} from kimi /v1/messages: {}",
                    truncate(&text, 500)
                )));
            }

            let bytes: BoxStream<'static, reqwest::Result<Bytes>> =
                response.bytes_stream().boxed();
            let chunk_stream: ChunkStream = Box::pin(KimiChunkStream::new(bytes));
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

pub(crate) fn build_inference_headers(api_key: &str) -> Result<HeaderMap> {
    let mut h = HeaderMap::new();

    h.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(bad_header)?,
    );

    h.insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/json"),
    );

    let ua = anthropic_fp::ua_sdk_cli();
    h.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_str(&ua).map_err(bad_header)?,
    );

    static_header(&mut h, "anthropic-version", anthropic_fp::ANTHROPIC_VERSION)?;
    static_header(
        &mut h,
        "anthropic-beta",
        anthropic_fp::ANTHROPIC_BETA_INFERENCE,
    )?;
    static_header(&mut h, "anthropic-dangerous-direct-browser-access", "true")?;

    static_header(&mut h, "x-stainless-lang", anthropic_fp::STAINLESS_LANG)?;
    static_header(
        &mut h,
        "x-stainless-package-version",
        anthropic_fp::STAINLESS_PACKAGE_VERSION,
    )?;
    static_header(&mut h, "x-stainless-runtime", anthropic_fp::STAINLESS_RUNTIME)?;
    static_header(
        &mut h,
        "x-stainless-runtime-version",
        anthropic_fp::STAINLESS_RUNTIME_VERSION,
    )?;
    static_header(&mut h, "x-stainless-timeout", anthropic_fp::STAINLESS_TIMEOUT)?;
    static_header(&mut h, "x-stainless-retry-count", "0")?;
    static_header(&mut h, "x-stainless-arch", anthropic_fp::stainless_arch())?;
    static_header(&mut h, "x-stainless-os", anthropic_fp::stainless_os())?;

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

struct KimiChunkStream {
    bytes: BoxStream<'static, reqwest::Result<Bytes>>,
    buf: SseBuffer,
    translator: AnthropicStreamTranslator,
    pending: VecDeque<OpenAiChunk>,
    finished: bool,
}

impl KimiChunkStream {
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

impl Stream for KimiChunkStream {
    type Item = Result<OpenAiChunk>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
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

        assert_eq!(ID, "kimi");
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
    fn inference_headers_carry_x_api_key_not_bearer() {

        let h = build_inference_headers("sk-kimi-test").unwrap();
        assert_eq!(h.get("x-api-key").unwrap(), "sk-kimi-test");
        assert!(
            !h.contains_key(reqwest::header::AUTHORIZATION),
            "Bearer Authorization header must not leak into the kimi request"
        );
    }

    #[test]
    fn inference_headers_match_anthropic_fingerprint_body() {

        let h = build_inference_headers("sk-kimi").unwrap();
        assert_eq!(h.get("content-type").unwrap(), "application/json");
        assert_eq!(h.get("accept").unwrap(), "application/json");
        assert_eq!(
            h.get("anthropic-version").unwrap(),
            anthropic_fp::ANTHROPIC_VERSION
        );
        assert_eq!(
            h.get("anthropic-beta").unwrap(),
            anthropic_fp::ANTHROPIC_BETA_INFERENCE
        );
        assert_eq!(
            h.get("anthropic-dangerous-direct-browser-access").unwrap(),
            "true"
        );
        assert_eq!(h.get("x-app").unwrap(), "cli");
        assert_eq!(
            h.get("x-stainless-lang").unwrap(),
            anthropic_fp::STAINLESS_LANG
        );

        let ua = h
            .get(reqwest::header::USER_AGENT)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ua.contains("claude-cli/"));
        assert!(ua.contains("(external, sdk-cli)"));
    }

    #[test]
    fn inference_headers_skip_context_1m_beta_for_kimi() {

        let h = build_inference_headers("sk-kimi").unwrap();
        let beta = h.get("anthropic-beta").unwrap().to_str().unwrap();
        assert!(!beta.contains("context-1m"),
            "Kimi does not advertise the anthropic 1m beta; body must stay Kimi-compatible: {beta}");
    }

    #[test]
    fn inference_headers_skip_claude_code_billing_header() {

        let h = build_inference_headers("sk-kimi").unwrap();
        assert!(!h.contains_key("x-anthropic-billing-header"));
    }

    #[test]
    fn inference_headers_generate_fresh_session_and_request_ids() {

        let a = build_inference_headers("sk-kimi").unwrap();
        let b = build_inference_headers("sk-kimi").unwrap();
        let a_sid = a.get("x-claude-code-session-id").unwrap().to_str().unwrap();
        let b_sid = b.get("x-claude-code-session-id").unwrap().to_str().unwrap();
        assert_ne!(a_sid, b_sid);
        let a_rid = a.get("x-client-request-id").unwrap().to_str().unwrap();
        assert_ne!(a_sid, a_rid);
        assert_eq!(a_sid.len(), 36);
    }

    #[tokio::test]
    async fn chunk_stream_decodes_anthropic_sse_corpus_fixture() {

        let wire: &[u8] = include_bytes!("../../../fingerprint_corpus/hello/response.sse");
        let mid = wire.len() / 2;
        let a = Bytes::copy_from_slice(&wire[..mid]);
        let b = Bytes::copy_from_slice(&wire[mid..]);
        let upstream = futures::stream::iter(vec![Ok(a), Ok(b)]).boxed();

        let mut stream = KimiChunkStream::new(upstream);
        let mut chunks = Vec::new();
        while let Some(item) = stream.next().await {
            chunks.push(item.expect("translation must not error"));
        }

        assert_eq!(chunks.len(), 5);
        assert_eq!(chunks[0].id, "XXX_MESSAGE_ID_XXX");
    }
}
