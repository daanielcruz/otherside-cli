

use std::convert::Infallible;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::{sse::Event, IntoResponse, Response, Sse},
};
use futures::stream::StreamExt;
use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::inference::{
    OpenAiChatCompletion, OpenAiChatCompletionChoice, OpenAiChatMessage, OpenAiChatRequest,
    OpenAiChatRole, OpenAiChunk,
};
use crate::provider::Registry;
use crate::thinking::parse_suffix;

use super::error::{error_response, ParseOrigin};
use super::sse::{done_terminator, encode_chunk};

#[derive(Clone)]
pub struct ServeState {
    pub registry: Arc<Registry>,

    pub default_provider: String,
}

pub async fn chat_completions(
    State(state): State<ServeState>,
    body: axum::body::Bytes,
) -> Response {
    let req: OpenAiChatRequest = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return error_response(
                &Error::Parse(format!("request body: {e}")),
                ParseOrigin::Request,
            );
        }
    };

    let (base_model, thinking) = match parse_suffix(&req.model) {
        Ok(v) => v,
        Err(e) => {
            return error_response(
                &Error::Parse(format!("invalid model suffix: {e}")),
                ParseOrigin::Request,
            );
        }
    };

    let provider = match state.registry.get(&state.default_provider) {
        Some(p) => p,
        None => {
            return error_response(
                &Error::Config(format!(
                    "provider {:?} is not registered",
                    state.default_provider
                )),
                ParseOrigin::Request,
            );
        }
    };

    let mut inference_req = req.clone();
    inference_req.model = base_model;

    let stream_mode = req.stream.unwrap_or(false);

    match provider.stream(inference_req, thinking).await {
        Ok(chunk_stream) => {
            if stream_mode {
                stream_response(chunk_stream)
            } else {
                aggregate_response(chunk_stream, &req.model).await
            }
        }

        Err(err) => error_response(&err, ParseOrigin::Upstream),
    }
}

fn stream_response(chunk_stream: crate::provider::ChunkStream) -> Response {

    enum Phase {
        Upstream(Result<OpenAiChunk, Error>),
        Terminator,
    }

    let upstream = chunk_stream.map(Phase::Upstream);

    let terminator = futures::stream::once(async { Phase::Terminator });

    let combined = upstream.chain(terminator);

    let body_stream = combined.map(|phase| -> Result<Event, Infallible> {
        match phase {
            Phase::Upstream(Ok(chunk)) => match encode_chunk(&chunk) {
                Ok(frame) => {

                    let json = frame
                        .strip_prefix("data: ")
                        .and_then(|s| s.strip_suffix("\n\n"))
                        .unwrap_or(&frame)
                        .to_string();
                    Ok(Event::default().data(json))
                }
                Err(_) => {

                    let inline = inline_error_event(&Error::Other(
                        "chunk serialization failed".into(),
                    ));
                    Ok(Event::default().data(inline))
                }
            },
            Phase::Upstream(Err(err)) => {
                let inline = inline_error_event(&err);
                Ok(Event::default().data(inline))
            }
            Phase::Terminator => Ok(Event::default().data("[DONE]")),
        }
    });

    let _ = done_terminator();

    Sse::new(body_stream).into_response()
}

fn inline_error_event(err: &Error) -> String {
    let payload = serde_json::json!({
        "error": {
            "message": err.to_string(),
            "type": "upstream",
            "code": "upstream",
        }
    });
    payload.to_string()
}

async fn aggregate_response(
    mut chunk_stream: crate::provider::ChunkStream,
    original_model: &str,
) -> Response {
    let mut content = String::new();
    let mut last_id: Option<String> = None;
    let mut last_model: Option<String> = None;
    let mut finish_reason: Option<String> = None;
    let mut first_chunk_created: Option<u64> = None;

    while let Some(item) = chunk_stream.next().await {
        match item {
            Ok(chunk) => {
                if first_chunk_created.is_none() {
                    first_chunk_created = Some(chunk.created);
                }
                last_id = Some(chunk.id.clone());
                last_model = Some(chunk.model.clone());
                if let Some(choice) = chunk.choices.into_iter().next() {
                    if let Some(delta_text) = choice.delta.content {
                        content.push_str(&delta_text);
                    }
                    if choice.finish_reason.is_some() {
                        finish_reason = choice.finish_reason;
                    }
                }
            }
            Err(err) => {

                return error_response(&err, ParseOrigin::Upstream);
            }
        }
    }

    let created = first_chunk_created.unwrap_or_else(now_epoch);
    let id = last_id.unwrap_or_else(|| "chatcmpl-unknown".to_string());

    let model = last_model.unwrap_or_else(|| original_model.to_string());

    let completion = OpenAiChatCompletion {
        id,
        object: OpenAiChatCompletion::OBJECT.to_string(),
        created,
        model,
        choices: vec![OpenAiChatCompletionChoice {
            index: 0,
            message: OpenAiChatMessage {
                role: OpenAiChatRole::Assistant,
                content,
                name: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            finish_reason,
        }],
    };

    (StatusCode::OK, Json(completion)).into_response()
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub async fn list_models() -> Json<ModelListing> {
    use crate::config::providers::ProviderId;
    let data: Vec<ModelEntry> = crate::models::catalog::models_for(ProviderId::ClaudeCode)
        .into_iter()
        .map(|m| ModelEntry {
            id: m.id.to_string(),
            object: "model",
        })
        .collect();
    Json(ModelListing { object: "list", data })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelListing {
    pub object: &'static str,
    pub data: Vec<ModelEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub object: &'static str,
}

#[cfg(test)]
pub(crate) async fn aggregate_response_for_test(
    chunks: Vec<Result<OpenAiChunk, Error>>,
    original_model: &str,
) -> Response {
    use futures::stream;
    let chunk_stream: crate::provider::ChunkStream =
        Box::pin(stream::iter(chunks));
    aggregate_response(chunk_stream, original_model).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::{OpenAiChatRole, OpenAiChoice, OpenAiDelta};
    use axum::body::to_bytes;

    fn mk_chunk(content: Option<&str>, finish: Option<&str>) -> OpenAiChunk {
        OpenAiChunk {
            id: "chatcmpl-x".to_string(),
            object: OpenAiChunk::OBJECT.to_string(),
            created: 1700000000,
            model: "claude-opus-4-7".to_string(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    role: if content.is_none() {
                        Some(OpenAiChatRole::Assistant)
                    } else {
                        None
                    },
                    content: content.map(|s| s.to_string()),
                    tool_calls: Vec::new(),
                },
                finish_reason: finish.map(|s| s.to_string()),
            }],
            usage: None,
        }
    }

    #[tokio::test]
    async fn aggregate_concatenates_deltas_and_preserves_finish_reason() {
        let chunks = vec![
            Ok(mk_chunk(None, None)),
            Ok(mk_chunk(Some("Hello"), None)),
            Ok(mk_chunk(Some(", world"), None)),
            Ok(mk_chunk(Some("!"), Some("stop"))),
        ];

        let resp = aggregate_response_for_test(chunks, "claude-opus-4-7(xhigh)").await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let completion: OpenAiChatCompletion = serde_json::from_slice(&body).unwrap();

        assert_eq!(completion.object, OpenAiChatCompletion::OBJECT);
        assert_eq!(completion.choices.len(), 1);
        assert_eq!(completion.choices[0].message.content, "Hello, world!");
        assert_eq!(completion.choices[0].message.role, OpenAiChatRole::Assistant);
        assert_eq!(completion.choices[0].finish_reason.as_deref(), Some("stop"));

        assert_eq!(completion.model, "claude-opus-4-7");
    }

    #[tokio::test]
    async fn aggregate_propagates_upstream_error_as_502() {
        let chunks = vec![
            Ok(mk_chunk(Some("Hi"), None)),
            Err(Error::Sse("truncated".into())),
        ];
        let resp = aggregate_response_for_test(chunks, "claude-opus-4-7").await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn aggregate_empty_stream_returns_empty_content() {
        let resp = aggregate_response_for_test(vec![], "claude-opus-4-7").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let completion: OpenAiChatCompletion = serde_json::from_slice(&body).unwrap();
        assert_eq!(completion.choices[0].message.content, "");
    }
}
