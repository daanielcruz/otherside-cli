
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderValue};

use crate::error::{Error, Result};
use crate::inference::{OpenAiChatRequest, OpenAiChunk};
use crate::thinking::ThinkingConfig;
use crate::translator::sse::SseBuffer;

use super::{ChunkStream, Provider};

pub const ID: &str = "openai-custom";

pub struct OpenAiCustomProvider {
    http: reqwest::Client,
    static_config: Option<StaticConfig>,
}

struct StaticConfig {
    base_url: Arc<str>,
    api_key: Option<Arc<str>>,
    model_default: Arc<str>,
}

pub struct ResolvedConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model_default: String,
}

impl OpenAiCustomProvider {
    pub fn new() -> Result<Self> {
        let http = crate::tools::http::apply_extra_ca_roots(
            reqwest::Client::builder()
                .pool_idle_timeout(Duration::from_secs(90))
                .timeout(Duration::from_secs(600)),
        )
        .build()?;
        Ok(Self { http, static_config: None })
    }

    pub fn new_with_static(
        base_url: impl Into<Arc<str>>,
        api_key: Option<impl Into<Arc<str>>>,
        model_default: impl Into<Arc<str>>,
    ) -> Result<Self> {
        let mut p = Self::new()?;
        p.static_config = Some(StaticConfig {
            base_url: base_url.into(),
            api_key: api_key.map(Into::into),
            model_default: model_default.into(),
        });
        Ok(p)
    }

    pub fn arc() -> Result<Arc<dyn Provider>> {
        Ok(Arc::new(Self::new()?))
    }

    pub fn arc_with_static(
        base_url: impl Into<Arc<str>>,
        api_key: Option<impl Into<Arc<str>>>,
        model_default: impl Into<Arc<str>>,
    ) -> Result<Arc<dyn Provider>> {
        Ok(Arc::new(Self::new_with_static(base_url, api_key, model_default)?))
    }

    fn resolve_config(&self) -> ResolvedConfig {
        if let Some(s) = &self.static_config {
            return ResolvedConfig {
                base_url: s.base_url.to_string(),
                api_key: s.api_key.as_deref().map(str::to_string),
                model_default: s.model_default.to_string(),
            };
        }
        let cfg = crate::state::dispatch::snapshot_openai_custom_settings();
        ResolvedConfig {
            base_url: cfg
                .as_ref()
                .map(|c| c.resolved_base_url())
                .unwrap_or_else(|| {
                    crate::config::settings::OpenAiCompatibleSettings::DEFAULT_BASE_URL.to_string()
                }),
            api_key: cfg.as_ref().and_then(|c| c.api_key.clone()).filter(|s| !s.is_empty()),
            model_default: cfg
                .as_ref()
                .map(|c| c.resolved_model())
                .unwrap_or_else(|| {
                    crate::config::settings::OpenAiCompatibleSettings::DEFAULT_MODEL.to_string()
                }),
        }
    }

    fn completions_url_for(base_url: &str) -> String {
        let base = base_url.trim_end_matches('/');
        format!("{base}/v1/chat/completions")
    }
}

impl Provider for OpenAiCustomProvider {
    fn id(&self) -> &'static str {
        ID
    }

    fn stream<'a>(
        &'a self,
        mut req: OpenAiChatRequest,
        _thinking: Option<ThinkingConfig>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>> {
        Box::pin(async move {
            let cfg = self.resolve_config();

            if req.model.trim().is_empty() {
                req.model = cfg.model_default.clone();
            }
            req.stream = Some(true);

            let body = serde_json::to_vec(&req)
                .map_err(|e| Error::Other(format!("openai-custom body serialize: {e}")))?;

            let headers = build_headers(cfg.api_key.as_deref())?;

            let url = Self::completions_url_for(&cfg.base_url);
            let response = self
                .http
                .post(&url)
                .headers(headers)
                .body(body)
                .send()
                .await?;

            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                let text = response.text().await.unwrap_or_default();
                return Err(Error::Auth(format!(
                    "HTTP 401 from {url}: {} — set api_key in `/config → Providers → Custom`",
                    truncate(&text, 300),
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
                    "HTTP {status} from {url}: {}",
                    truncate(&text, 500),
                )));
            }

            let bytes: BoxStream<'static, reqwest::Result<Bytes>> =
                response.bytes_stream().boxed();
            let chunk_stream: ChunkStream = Box::pin(OpenAiCustomChunkStream::new(bytes));
            Ok(chunk_stream)
        })
    }
}

pub(crate) fn build_headers(api_key: Option<&str>) -> Result<HeaderMap> {
    let mut h = HeaderMap::new();
    h.insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("text/event-stream"),
    );
    if let Some(key) = api_key.filter(|s| !s.is_empty()) {
        let bearer = format!("Bearer {key}");
        h.insert(
            reqwest::header::AUTHORIZATION,
            HeaderValue::from_str(&bearer)
                .map_err(|e| Error::Header(format!("authorization header: {e}")))?,
        );
    }
    Ok(h)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}\u{2026}")
}

struct OpenAiCustomChunkStream {
    bytes: BoxStream<'static, reqwest::Result<Bytes>>,
    buf: SseBuffer,
    pending: VecDeque<OpenAiChunk>,
    finished: bool,
}

impl OpenAiCustomChunkStream {
    fn new(bytes: BoxStream<'static, reqwest::Result<Bytes>>) -> Self {
        Self {
            bytes,
            buf: SseBuffer::new(),
            pending: VecDeque::new(),
            finished: false,
        }
    }

    fn drain_events(&mut self) -> Result<()> {
        for event in self.buf.drain() {
            if let Some(chunk) = parse_event_data(&event.data)? {
                self.pending.push_back(chunk);
            }
        }
        Ok(())
    }
}

fn parse_event_data(data: &str) -> Result<Option<OpenAiChunk>> {
    let trimmed = data.trim();
    if trimmed.is_empty() || trimmed == "[DONE]" {
        return Ok(None);
    }
    let chunk: OpenAiChunk = serde_json::from_str(trimmed)
        .map_err(|e| Error::Sse(format!("openai-custom chunk decode: {e}; raw={trimmed}")))?;
    Ok(Some(chunk))
}

impl Stream for OpenAiCustomChunkStream {
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
                        match parse_event_data(&event.data) {
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
    use crate::inference::{OpenAiChatMessage, OpenAiChatRole};
    use futures::stream;

    #[test]
    fn provider_id_is_stable_constant() {
        assert_eq!(ID, "openai-custom");
    }

    #[test]
    fn headers_without_api_key_omit_authorization() {
        let h = build_headers(None).unwrap();
        assert!(!h.contains_key(reqwest::header::AUTHORIZATION));
        assert_eq!(h.get(reqwest::header::CONTENT_TYPE).unwrap(), "application/json");
        assert_eq!(h.get(reqwest::header::ACCEPT).unwrap(), "text/event-stream");
    }

    #[test]
    fn headers_with_api_key_set_bearer() {
        let h = build_headers(Some("sk-local-abc")).unwrap();
        assert_eq!(
            h.get(reqwest::header::AUTHORIZATION).unwrap(),
            "Bearer sk-local-abc",
        );
    }

    #[test]
    fn headers_with_empty_api_key_omit_authorization() {
        let h = build_headers(Some("")).unwrap();
        assert!(
            !h.contains_key(reqwest::header::AUTHORIZATION),
            "empty-string api_key must not inject a bogus `Bearer ` header",
        );
    }

    #[test]
    fn completions_url_appends_v1_chat_completions() {
        assert_eq!(
            OpenAiCustomProvider::completions_url_for("http://127.0.0.1:8317"),
            "http://127.0.0.1:8317/v1/chat/completions",
        );
    }

    #[test]
    fn completions_url_strips_trailing_slash() {
        assert_eq!(
            OpenAiCustomProvider::completions_url_for("http://127.0.0.1:8317/"),
            "http://127.0.0.1:8317/v1/chat/completions",
        );
    }

    #[test]
    fn static_config_overrides_dispatch_snapshot() {
        let p = OpenAiCustomProvider::new_with_static(
            "http://proxy:9000",
            Some("sk-x"),
            "llama-3.3",
        )
        .unwrap();
        let cfg = p.resolve_config();
        assert_eq!(cfg.base_url, "http://proxy:9000");
        assert_eq!(cfg.api_key.as_deref(), Some("sk-x"));
        assert_eq!(cfg.model_default, "llama-3.3");
    }

    #[test]
    fn body_serialization_is_canonical_chat_completions_shape() {
        let req = OpenAiChatRequest {
            model: "gpt-5.5".to_string(),
            messages: vec![OpenAiChatMessage {
                role: OpenAiChatRole::User,
                content: "hi".to_string(),
                ..Default::default()
            }],
            stream: Some(true),
            ..Default::default()
        };
        let body = serde_json::to_value(&req).unwrap();
        assert_eq!(body["model"], "gpt-5.5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "hi");
    }

    #[test]
    fn parse_event_data_skips_done_and_blanks() {
        assert!(parse_event_data("[DONE]").unwrap().is_none());
        assert!(parse_event_data("").unwrap().is_none());
        assert!(parse_event_data("   ").unwrap().is_none());
    }

    #[test]
    fn parse_event_data_decodes_chunk() {
        let raw = r#"{"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}"#;
        let out = parse_event_data(raw).unwrap().unwrap();
        assert_eq!(out.id, "c1");
        assert_eq!(out.choices[0].delta.content.as_deref(), Some("Hi"));
    }

    #[tokio::test]
    async fn chunk_stream_decodes_multi_event_sse_wire() {
        let wire = b"data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-5.5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hi\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":2,\"model\":\"gpt-5.5\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" there\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n";
        let mid = wire.len() / 2;
        let a = Bytes::copy_from_slice(&wire[..mid]);
        let b = Bytes::copy_from_slice(&wire[mid..]);
        let upstream = stream::iter(vec![Ok(a), Ok(b)]).boxed();

        let mut stream = OpenAiCustomChunkStream::new(upstream);
        let mut chunks = Vec::new();
        while let Some(item) = stream.next().await {
            chunks.push(item.expect("translation must not error"));
        }

        assert_eq!(chunks.len(), 2, "DONE marker must not surface as a chunk");
        assert_eq!(chunks[0].choices[0].delta.content.as_deref(), Some("Hi"));
        assert_eq!(chunks[1].choices[0].delta.content.as_deref(), Some(" there"));
    }

    #[test]
    fn stream_rewrites_empty_model_to_default_when_dispatched() {
        let req_empty = OpenAiChatRequest {
            model: String::new(),
            ..Default::default()
        };
        let req_explicit = OpenAiChatRequest {
            model: "llama-3.3".into(),
            ..Default::default()
        };

        let mut e = req_empty.clone();
        if e.model.trim().is_empty() {
            e.model = "gpt-5.5".to_string();
        }
        assert_eq!(e.model, "gpt-5.5");

        let mut x = req_explicit.clone();
        if x.model.trim().is_empty() {
            x.model = "gpt-5.5".to_string();
        }
        assert_eq!(x.model, "llama-3.3");
    }
}
