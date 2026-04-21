//! `otherside serve` — OpenAI-compatible local HTTP proxy.
//!
//! The server exposes `/v1/chat/completions` and `/v1/models` on a loopback
//! socket, accepts OpenAI-shape requests, and funnels them through the same
//! [`Provider::stream`](crate::provider::Provider::stream) pipeline that
//! powers `otherside -p`. Clients that only speak OpenAI (Cursor, Cline,
//! aider, Continue) can therefore ride the user's upstream OAuth
//! subscription by pointing at `http://localhost:<port>/v1` with a dummy
//! API key.
//!
//! # Why a thin server
//!
//! The canonical request shape in otherside is already OpenAI's, so the
//! server is almost an identity layer: parse JSON, hand off to the provider,
//! re-emit chunks as OpenAI SSE. The only bespoke logic is
//! streaming-vs-aggregate response selection and error mapping.
//!
//! # Layout
//!
//! - [`handlers`] — axum route handlers (`POST /v1/chat/completions`,
//!   `GET /v1/models`).
//! - [`sse`] — pure encoder for `data: <json>\n\n` frames plus the
//!   `[DONE]` sentinel.
//! - [`error`] — library [`crate::error::Error`] → axum `Response` mapping
//!   in the OpenAI error body shape.
//!
//! # MVP scope (see change `002-serve-openai-compat`)
//!
//! - Streaming + non-streaming chat completions — both wired.
//! - `/v1/models` stub listing.
//! - Single registered provider (anthropic-oauth). Multi-provider routing
//!   by model id is Phase 2.
//! - No server-side auth. Binding defaults to `127.0.0.1`; remote binds are
//!   allowed but explicitly undocumented for MVP because we don't yet
//!   implement the spec's API-key gate for non-loopback.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{routing::{get, post}, Router};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;

use crate::error::{Error, Result};
use crate::provider::Registry;

pub mod error;
pub mod handlers;
pub mod sse;

use handlers::ServeState;

/// Build the axum router. Exposed so tests can exercise the routing layer
/// with in-process HTTP rather than spinning up a real socket.
pub fn router(state: ServeState) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(handlers::chat_completions))
        .route("/v1/models", get(handlers::list_models))
        // Trace layer gives us request spans for free — useful when
        // debugging which clients are hitting us with what shape.
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Bind and serve until the process terminates.
///
/// Prints the actual bound address to stdout (per the serve spec) so the
/// caller can confirm the ephemeral port when binding to `:0`.
pub async fn run(
    bind: SocketAddr,
    registry: Arc<Registry>,
    default_provider: String,
) -> Result<()> {
    let state = ServeState {
        registry,
        default_provider,
    };
    let app = router(state);

    let listener = TcpListener::bind(bind)
        .await
        .map_err(|e| Error::Other(format!("bind {bind}: {e}")))?;
    let local = listener
        .local_addr()
        .map_err(|e| Error::Other(format!("local_addr: {e}")))?;

    // Emit to stdout — the spec requires this so shell scripts can parse
    // the actual bind address (important when `--port 0` is used).
    println!("otherside serve: listening on http://{local}");
    println!("  POST /v1/chat/completions");
    println!("  GET  /v1/models");

    axum::serve(listener, app)
        .await
        .map_err(|e| Error::Other(format!("serve: {e}")))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::{
        OpenAiChatRole, OpenAiChoice, OpenAiChunk, OpenAiDelta,
    };
    use crate::provider::{ChunkStream, Provider};
    use crate::thinking::ThinkingConfig;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use futures::stream;
    use std::pin::Pin;
    use tower::ServiceExt;

    /// In-memory provider that emits a canned chunk sequence — lets the
    /// router tests exercise the full request → response path without any
    /// network hits.
    struct StubProvider;

    impl Provider for StubProvider {
        fn id(&self) -> &'static str {
            "anthropic-oauth"
        }

        fn stream<'a>(
            &'a self,
            _req: crate::inference::OpenAiChatRequest,
            _thinking: Option<ThinkingConfig>,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<ChunkStream>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                let chunks: Vec<Result<OpenAiChunk>> = vec![
                    Ok(OpenAiChunk {
                        id: "chatcmpl-test".into(),
                        object: OpenAiChunk::OBJECT.into(),
                        created: 1700000000,
                        model: "claude-opus-4-7".into(),
                        choices: vec![OpenAiChoice {
                            index: 0,
                            delta: OpenAiDelta {
                                role: Some(OpenAiChatRole::Assistant),
                                content: None,
                                tool_calls: Vec::new(),
                            },
                            finish_reason: None,
                        }],
                        usage: None,
                    }),
                    Ok(OpenAiChunk {
                        id: "chatcmpl-test".into(),
                        object: OpenAiChunk::OBJECT.into(),
                        created: 1700000000,
                        model: "claude-opus-4-7".into(),
                        choices: vec![OpenAiChoice {
                            index: 0,
                            delta: OpenAiDelta {
                                role: None,
                                content: Some("pong".into()),
                                tool_calls: Vec::new(),
                            },
                            finish_reason: Some("stop".into()),
                        }],
                        usage: None,
                    }),
                ];
                let s: ChunkStream = Box::pin(stream::iter(chunks));
                Ok(s)
            })
        }
    }

    fn test_app() -> Router {
        let registry = Arc::new(
            Registry::builder()
                .with(Arc::new(StubProvider))
                .build(),
        );
        router(ServeState {
            registry,
            default_provider: "anthropic-oauth".into(),
        })
    }

    #[tokio::test]
    async fn list_models_returns_stub_entry() {
        let app = test_app();
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["object"], "list");
        assert_eq!(body["data"][0]["id"], "claude-opus-4-7");
    }

    #[tokio::test]
    async fn non_streaming_chat_returns_aggregated_completion() {
        let app = test_app();
        let body = r#"{
            "model":"claude-opus-4-7",
            "messages":[{"role":"user","content":"ping"}],
            "stream":false
        }"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["object"], "chat.completion");
        assert_eq!(body["choices"][0]["message"]["content"], "pong");
        assert_eq!(body["choices"][0]["finish_reason"], "stop");
    }

    #[tokio::test]
    async fn streaming_chat_emits_sse_with_done_terminator() {
        let app = test_app();
        let body = r#"{
            "model":"claude-opus-4-7",
            "messages":[{"role":"user","content":"ping"}],
            "stream":true
        }"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            ct.starts_with("text/event-stream"),
            "unexpected content-type: {ct}"
        );
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        // Every compliant OpenAI SSE client keys on this sentinel.
        assert!(text.contains("data: [DONE]"), "body: {text}");
        // At least one real chunk made it through.
        assert!(text.contains("\"chat.completion.chunk\""), "body: {text}");
    }

    #[tokio::test]
    async fn malformed_request_body_is_400_with_openai_error_shape() {
        let app = test_app();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .body(Body::from("not json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        // OpenAI error envelope — every SDK parses these fields.
        assert!(body["error"]["message"].is_string());
        assert_eq!(body["error"]["type"], "bad_request");
        assert_eq!(body["error"]["code"], "bad_request");
    }
}
