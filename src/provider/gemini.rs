
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use uuid::Uuid;

use crate::auth::gemini as auth;
use crate::error::{Error, Result};
use crate::fingerprint::gemini as fp;
use crate::inference::{OpenAiChatRequest, OpenAiChunk};
use crate::thinking::ThinkingConfig;
use crate::translator::gemini::request::build_request_body;
use crate::translator::gemini::response as gemini_response;
use crate::translator::sse::SseBuffer;

use super::{ChunkStream, Provider};

pub const ID: &str = "gemini-oauth";

pub struct GeminiProvider {
    http: reqwest::Client,
    session_id: String,
    project_id: RwLock<Option<String>>,
}

impl GeminiProvider {
    pub fn new() -> Result<Self> {
        let http = crate::tools::http::apply_extra_ca_roots(
            reqwest::Client::builder()
                .pool_idle_timeout(Duration::from_secs(90))
                .timeout(Duration::from_secs(600)),
        )
        .build()?;
        Ok(Self {
            http,
            session_id: Uuid::new_v4().to_string(),
            project_id: RwLock::new(None),
        })
    }

    pub fn arc() -> Result<Arc<dyn Provider>> {
        Ok(Arc::new(Self::new()?))
    }

    fn cached_project_id(&self) -> Option<String> {
        self.project_id.read().ok().and_then(|r| r.clone())
    }

    fn remember_project_id(&self, pid: &str) {
        if let Ok(mut w) = self.project_id.write() {
            *w = Some(pid.to_string());
        }
    }
}

impl Provider for GeminiProvider {
    fn id(&self) -> &'static str {
        ID
    }

    fn stream<'a>(
        &'a self,
        req: OpenAiChatRequest,
        thinking: Option<ThinkingConfig>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>> {
        Box::pin(async move {
            let mut creds = auth::current_credentials().await?;
            let project_id = match creds.project_id.clone() {
                Some(p) if !p.is_empty() => p,
                _ => match self.cached_project_id() {
                    Some(p) => p,
                    None => auth::ensure_project_id(&mut creds).await?,
                },
            };
            self.remember_project_id(&project_id);
            let bearer = format!("Bearer {}", creds.access_token);
            let project_id = Some(project_id);

            let user_prompt_id = Uuid::new_v4().to_string();
            let body = build_request_body(
                &req,
                thinking.as_ref(),
                project_id.as_deref(),
                Some(&self.session_id),
                Some(&user_prompt_id),
            );
            let body_bytes = serde_json::to_vec(&body)
                .map_err(|e| Error::Other(format!("gemini body serialize: {e}")))?;

            let headers = build_inference_headers(&bearer)?;

            let url = format!("{}?alt=sse", fp::stream_generate_content_url());
            let response = self
                .http
                .post(&url)
                .headers(headers)
                .body(body_bytes)
                .send()
                .await?;

            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                let text = response.text().await.unwrap_or_default();
                return Err(Error::Auth(format!(
                    "HTTP 401 from gemini {}: {} — run `otherside login --provider gemini`",
                    fp::CODE_ASSIST_ENDPOINT,
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
                    "HTTP {status} from gemini streamGenerateContent: {}",
                    truncate(&text, 500)
                )));
            }

            let bytes: BoxStream<'static, reqwest::Result<Bytes>> =
                response.bytes_stream().boxed();
            let stream: ChunkStream = Box::pin(GeminiChunkStream::new(bytes, req.model.clone()));
            Ok(stream)
        })
    }
}

pub(crate) fn build_inference_headers(bearer: &str) -> Result<HeaderMap> {
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
        HeaderValue::from_static("text/event-stream"),
    );
    h.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_str(&user_agent()).map_err(bad_header)?,
    );
    h.insert(
        HeaderName::from_static("x-goog-api-client"),
        HeaderValue::from_str(&goog_api_client()).map_err(bad_header)?,
    );
    Ok(h)
}

fn user_agent() -> String {
    format!(
        "GeminiCLI/{} ({} {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

fn goog_api_client() -> String {
    format!("gl-rust/{} otherside-cli/{}", rust_version(), env!("CARGO_PKG_VERSION"))
}

fn rust_version() -> &'static str {
    option_env!("CARGO_PKG_RUST_VERSION").unwrap_or("1.83")
}

fn bad_header<E: std::fmt::Display>(e: E) -> Error {
    Error::Header(format!("invalid header value: {e}"))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

struct GeminiChunkStream {
    bytes: BoxStream<'static, reqwest::Result<Bytes>>,
    buffer: SseBuffer,
    translator: gemini_response::State,
    pending: VecDeque<OpenAiChunk>,
    done: bool,
}

impl GeminiChunkStream {
    fn new(bytes: BoxStream<'static, reqwest::Result<Bytes>>, model_hint: String) -> Self {
        Self {
            bytes,
            buffer: SseBuffer::new(),
            translator: gemini_response::State::new(&model_hint),
            pending: VecDeque::new(),
            done: false,
        }
    }

    fn drain_events(&mut self) {
        while let Some(event) = self.buffer.pop() {
            let payload: serde_json::Value = match serde_json::from_str(&event.data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let chunks = self.translator.ingest(&payload);
            for c in chunks {
                self.pending.push_back(c);
            }
            if self.translator.finished {
                self.done = true;
                break;
            }
        }
    }
}

impl Stream for GeminiChunkStream {
    type Item = Result<OpenAiChunk>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            if let Some(chunk) = self.pending.pop_front() {
                return Poll::Ready(Some(Ok(chunk)));
            }
            if self.done {
                return Poll::Ready(None);
            }
            let next = futures::ready!(self.bytes.as_mut().poll_next(cx));
            match next {
                Some(Ok(bytes)) => {
                    self.buffer.push(&bytes);
                    self.drain_events();
                }
                Some(Err(e)) => {
                    return Poll::Ready(Some(Err(Error::Other(format!("gemini stream: {e}")))));
                }
                None => {
                    if let Some(event) = self.buffer.flush_on_eof() {
                        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.data)
                        {
                            for c in self.translator.ingest(&payload) {
                                self.pending.push_back(c);
                            }
                        }
                    }
                    self.done = true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_is_stable_constant() {
        assert_eq!(ID, "gemini-oauth");
    }

    #[test]
    fn headers_carry_bearer_content_type_and_accept_sse() {
        let h = build_inference_headers("Bearer AT").unwrap();
        assert_eq!(h.get(reqwest::header::AUTHORIZATION).unwrap(), "Bearer AT");
        assert_eq!(h.get(reqwest::header::CONTENT_TYPE).unwrap(), "application/json");
        assert_eq!(h.get(reqwest::header::ACCEPT).unwrap(), "text/event-stream");
        assert!(h.contains_key("x-goog-api-client"));
    }

    #[test]
    fn truncate_appends_ellipsis_when_over_limit() {
        assert_eq!(truncate("abcdef", 3), "abc…");
    }

    #[test]
    fn truncate_leaves_short_strings_alone() {
        assert_eq!(truncate("ok", 10), "ok");
    }
}
