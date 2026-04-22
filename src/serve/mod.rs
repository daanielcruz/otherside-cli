

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

pub fn router(state: ServeState) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(handlers::chat_completions))
        .route("/v1/models", get(handlers::list_models))

        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

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
                                ..Default::default()
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
                                ..Default::default()
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

        assert_eq!(body["data"][0]["id"], "claude-opus-4-7[1m]");
        let ids: Vec<&str> = body["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["id"].as_str())
            .collect();
        assert!(ids.iter().any(|id| *id == "claude-opus-4-7"));
        assert!(ids.iter().any(|id| *id == "claude-sonnet-4-6"));
        assert!(ids.iter().any(|id| *id == "claude-haiku-4-5"));
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

        assert!(text.contains("data: [DONE]"), "body: {text}");

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

        assert!(body["error"]["message"].is_string());
        assert_eq!(body["error"]["type"], "bad_request");
        assert_eq!(body["error"]["code"], "bad_request");
    }
}
