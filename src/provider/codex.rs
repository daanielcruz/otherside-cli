
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::auth::codex as auth;
use crate::error::{Error, Result};
use crate::fingerprint::codex as fp;
use crate::inference::{OpenAiChatRequest, OpenAiChunk};
use crate::thinking::ThinkingConfig;
use crate::translator::anthropic::UserContext;
use crate::translator::codex::response;
use crate::translator::codex::request::openai_tools_to_codex_tools;
use crate::translator::sse::SseBuffer;

use super::{ChunkStream, Provider};

pub const ID: &str = "codex-oauth";

pub struct CodexProvider {
    http: reqwest::Client,
    session_id: String,
    parent_thread_id: String,
    turn_counter: RwLock<u32>,
    last_response_id: Arc<RwLock<Option<String>>>,
}

impl CodexProvider {
    pub fn new() -> Result<Self> {
        let http = crate::tools::http::apply_extra_ca_roots(
            reqwest::Client::builder().pool_idle_timeout(Duration::from_secs(90)),
        )
        .build()?;
        Ok(Self {
            http,
            session_id: fp::new_session_id(),
            parent_thread_id: fp::new_session_id(),
            turn_counter: RwLock::new(0),
            last_response_id: Arc::new(RwLock::new(None)),
        })
    }

    pub fn arc() -> Result<Arc<dyn Provider>> {
        Ok(Arc::new(Self::new()?))
    }

    fn next_turn(&self) -> u32 {
        let mut w = self.turn_counter.write().expect("turn_counter lock");
        *w = w.saturating_add(1);
        *w
    }

    fn last_response_id_snapshot(&self) -> Option<String> {
        self.last_response_id.read().ok().and_then(|r| r.clone())
    }
}

impl Provider for CodexProvider {
    fn id(&self) -> &'static str {
        ID
    }

    fn stream<'a>(
        &'a self,
        req: OpenAiChatRequest,
        thinking: Option<ThinkingConfig>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>> {
        Box::pin(async move {
            let creds = auth::current_credentials().await?;
            let bearer = format!("Bearer {}", creds.access_token);

            let tools_json = openai_tools_to_codex_tools(&req.tools);

            let env = crate::harness::session_env::resolve();
            let user_ctx = UserContext {
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
            let fast_mode = crate::state::dispatch::snapshot()
                .map(|s| s.fast_mode)
                .unwrap_or(false);
            let service_tier =
                if fast_mode && codex_model_supports_fast(&req.model) {
                    Some("priority")
                } else {
                    None
                };
            let turn = self.next_turn();
            let previous_response_id = self.last_response_id_snapshot();
            let is_subagent = crate::agent::subagents::is_running_inside_subagent();
            let body = crate::translator::codex::request::build_responses_body_full(
                &req,
                tools_json,
                thinking.as_ref(),
                Some(&user_ctx),
                service_tier,
                previous_response_id.as_deref(),
                turn,
                is_subagent,
            );
            let body_bytes = serde_json::to_vec(&body)
                .map_err(|e| Error::Other(format!("codex body serialize: {e}")))?;

            let headers = build_responses_headers(
                &bearer,
                creds.account_id.as_deref(),
                &self.session_id,
                &self.parent_thread_id,
                turn,
                previous_response_id.is_some(),
                is_subagent,
            )?;

            let url = format!("{}{}", fp::CHATGPT_BASE_URL, fp::RESPONSES_ENDPOINT);
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
                    "HTTP 401 from codex /responses: {} - run `otherside login --provider codex`",
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
                    "HTTP {status} from codex /responses: {}",
                    truncate(&text, 500)
                )));
            }

            let model_echo = response
                .headers()
                .get("openai-model")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(&req.model)
                .to_string();

            let bytes: BoxStream<'static, reqwest::Result<Bytes>> =
                response.bytes_stream().boxed();
            let response_id_sink = self.last_response_id.clone();
            let stream: ChunkStream = Box::pin(CodexChunkStream::new(
                bytes,
                model_echo,
                response_id_sink,
            ));
            Ok(stream)
        })
    }
}

struct CodexChunkStream {
    bytes: BoxStream<'static, reqwest::Result<Bytes>>,
    buffer: SseBuffer,
    translator: response::State,
    pending: std::collections::VecDeque<OpenAiChunk>,
    done: bool,
    response_id_sink: Arc<RwLock<Option<String>>>,
}

impl CodexChunkStream {
    fn new(
        bytes: BoxStream<'static, reqwest::Result<Bytes>>,
        model_hint: String,
        response_id_sink: Arc<RwLock<Option<String>>>,
    ) -> Self {
        Self {
            bytes,
            buffer: SseBuffer::new(),
            translator: response::State::new(&model_hint),
            pending: std::collections::VecDeque::new(),
            done: false,
            response_id_sink,
        }
    }

    fn flush_response_id(&self) {
        if let Some(id) = self.translator.response_id.as_ref() {
            if let Ok(mut w) = self.response_id_sink.write() {
                *w = Some(id.clone());
            }
        }
    }
}

impl Stream for CodexChunkStream {
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
                    while let Some(event) = self.buffer.pop() {

                        let payload: serde_json::Value =
                            match serde_json::from_str(&event.data) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                        let chunks = self.translator.ingest(&event.event, &payload);
                        for c in chunks {
                            self.pending.push_back(c);
                        }
                        if self.translator.finished {
                            self.flush_response_id();
                            self.done = true;
                            break;
                        }
                    }
                }
                Some(Err(e)) => {
                    return Poll::Ready(Some(Err(Error::Other(format!("codex stream: {e}")))));
                }
                None => {
                    if let Some(event) = self.buffer.flush_on_eof() {
                        let payload: serde_json::Value =
                            serde_json::from_str(&event.data).unwrap_or(serde_json::Value::Null);
                        let chunks = self.translator.ingest(&event.event, &payload);
                        for c in chunks {
                            self.pending.push_back(c);
                        }
                    }
                    self.flush_response_id();
                    self.done = true;
                }
            }
        }
    }
}

fn build_responses_headers(
    bearer: &str,
    account_id: Option<&str>,
    session_id: &str,
    parent_thread_id: &str,
    turn: u32,
    continuing: bool,
    is_subagent: bool,
) -> Result<HeaderMap> {
    let mut h = HeaderMap::new();
    h.insert(
        reqwest::header::AUTHORIZATION,
        HeaderValue::from_str(bearer)
            .map_err(|e| Error::Header(format!("auth header: {e}")))?,
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
        HeaderValue::from_str(&fp::user_agent())
            .map_err(|e| Error::Header(format!("ua header: {e}")))?,
    );
    h.insert(
        HeaderName::from_static("originator"),
        HeaderValue::from_static(fp::ORIGINATOR),
    );
    h.insert(
        HeaderName::from_static("session_id"),
        HeaderValue::from_str(session_id)
            .map_err(|e| Error::Header(format!("session_id header: {e}")))?,
    );
    h.insert(
        HeaderName::from_static("x-codex-installation-id"),
        HeaderValue::from_str(&fp::installation_id())
            .map_err(|e| Error::Header(format!("installation-id header: {e}")))?,
    );
    h.insert(
        HeaderName::from_static("x-codex-window-id"),
        HeaderValue::from_str(&fp::window_id())
            .map_err(|e| Error::Header(format!("window-id header: {e}")))?,
    );
    h.insert(
        HeaderName::from_static("x-codex-parent-thread-id"),
        HeaderValue::from_str(parent_thread_id)
            .map_err(|e| Error::Header(format!("parent-thread-id header: {e}")))?,
    );
    let turn_state = if continuing { "continued" } else { "new" };
    h.insert(
        HeaderName::from_static("x-codex-turn-state"),
        HeaderValue::from_static(turn_state),
    );
    let turn_metadata = format!(r#"{{"turn":{turn}}}"#);
    h.insert(
        HeaderName::from_static("x-codex-turn-metadata"),
        HeaderValue::from_str(&turn_metadata)
            .map_err(|e| Error::Header(format!("turn-metadata header: {e}")))?,
    );
    h.insert(
        HeaderName::from_static("x-openai-subagent"),
        HeaderValue::from_static(if is_subagent { "true" } else { "false" }),
    );
    if let Some(acct) = account_id {
        h.insert(
            HeaderName::from_static("chatgpt-account-id"),
            HeaderValue::from_str(acct)
                .map_err(|e| Error::Header(format!("account-id header: {e}")))?,
        );
    }
    Ok(h)
}

fn codex_model_supports_fast(model: &str) -> bool {
    crate::provider::codex_models::supports_fast_tier(model)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_include_all_fingerprint_fields() {
        let h = build_responses_headers("Bearer AT", Some("acct-xyz"), "sess-1", "thr-1", 1, false, false).unwrap();
        assert_eq!(h.get("authorization").unwrap(), "Bearer AT");
        assert_eq!(h.get("content-type").unwrap(), "application/json");
        assert_eq!(h.get("accept").unwrap(), "text/event-stream");
        assert_eq!(h.get("originator").unwrap(), "codex_cli_rs");
        assert_eq!(h.get("session_id").unwrap(), "sess-1");
        assert_eq!(h.get("chatgpt-account-id").unwrap(), "acct-xyz");
        assert!(h.contains_key("x-codex-installation-id"));
        assert!(h.contains_key("x-codex-window-id"));
        assert_eq!(h.get("x-codex-parent-thread-id").unwrap(), "thr-1");
        assert_eq!(h.get("x-codex-turn-state").unwrap(), "new");
        assert_eq!(h.get("x-codex-turn-metadata").unwrap(), "{\"turn\":1}");
        assert_eq!(h.get("x-openai-subagent").unwrap(), "false");
        assert!(h.get("user-agent").unwrap().to_str().unwrap().starts_with("codex_cli_rs/"));
    }

    #[test]
    fn headers_skip_account_id_when_none() {
        let h = build_responses_headers("Bearer AT", None, "sess-2", "thr-2", 1, false, false).unwrap();
        assert!(!h.contains_key("chatgpt-account-id"));
    }

    #[test]
    fn headers_turn_state_continued_when_previous_response_id_present() {
        let h = build_responses_headers("Bearer AT", None, "sess-3", "thr-3", 4, true, false).unwrap();
        assert_eq!(h.get("x-codex-turn-state").unwrap(), "continued");
        assert_eq!(h.get("x-codex-turn-metadata").unwrap(), "{\"turn\":4}");
    }

    #[test]
    fn headers_subagent_flag_flips_to_true_when_running_inside_subagent_scope() {
        let h = build_responses_headers("Bearer AT", None, "sess-4", "thr-4", 2, false, true).unwrap();
        assert_eq!(h.get("x-openai-subagent").unwrap(), "true");
    }
}
