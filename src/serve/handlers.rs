//! Axum route handlers for `otherside serve`.
//!
//! Each route converts between HTTP and the canonical otherside pipeline:
//! parse the request body into an [`OpenAiChatRequest`], resolve the
//! provider via the shared [`Registry`], run [`Provider::stream`], then
//! either re-encode chunks as OpenAI SSE (streaming) or aggregate them into
//! a single `chat.completion` response (non-streaming).
//!
//! # Why a small handler layer
//!
//! The heavy lifting (translation, fingerprinting, OAuth) lives inside the
//! provider. This file is deliberately thin — it owns HTTP concerns only.
//! Any bug in the provider path is equally visible to `otherside -p` and to
//! `otherside serve`, which is what we want.

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

/// Shared state passed to every handler.
///
/// Held as `Arc` because axum clones the state per request — we want cheap
/// clones, not copies.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<Registry>,
    /// Fallback provider id when the request's `model` doesn't disambiguate.
    /// MVP: any model id routes here, since only `anthropic-oauth` is
    /// registered. Multi-provider routing lands in Phase 2.
    pub default_provider: String,
}

/// `POST /v1/chat/completions`.
///
/// Accepts the OpenAI shape, dispatches via [`Provider::stream`], and emits
/// either SSE or a single JSON response depending on `stream`.
///
/// We parse the body into `serde_json::Value` first so malformed bodies
/// surface as a 400 instead of axum's default 422 extractor error — OpenAI
/// clients expect 400 with the OpenAI error shape.
pub async fn chat_completions(
    State(state): State<AppState>,
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

    // Split the suffix off the model name so what goes on the wire is the
    // bare model id, mirroring `cmd_print`. Suffix parser failures are the
    // client's fault — return 400.
    let (base_model, thinking) = match parse_suffix(&req.model) {
        Ok(v) => v,
        Err(e) => {
            return error_response(
                &Error::Parse(format!("invalid model suffix: {e}")),
                ParseOrigin::Request,
            );
        }
    };

    // MVP routing: single registered provider. When multi-provider lands
    // we'll switch on a model-id prefix ("claude-*" → anthropic,
    // "gpt-*" → codex, etc.) but for now we simply take the configured
    // default.
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

    // Rewrite the model slot with the bare name — the suffix stays in
    // `thinking` and is applied by the translator.
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
        // The future itself failed before any chunk was emitted — treat as
        // upstream for Parse/Sse variants since at this point the client
        // body is already accepted.
        Err(err) => error_response(&err, ParseOrigin::Upstream),
    }
}

/// Build the SSE response body for a streaming request.
///
/// We map each upstream `Result<OpenAiChunk>` to an `Event`, appending a
/// single `[DONE]` sentinel when the stream ends — OpenAI's documented
/// terminator. Errors from the upstream stream are re-encoded as inline
/// `data:` error events (no HTTP status change, since headers already
/// flew). This mirrors how OpenAI itself reports mid-stream failures.
///
/// Uses `futures::stream` combinators rather than a stream macro so we
/// don't pull in another proc-macro dep; the result type is the same.
fn stream_response(chunk_stream: crate::provider::ChunkStream) -> Response {
    // `Upstream(Some(chunk_result))` represents one upstream payload;
    // `Terminator` is the final `[DONE]` sentinel we synthesize after
    // the upstream ends. Two phases flattened into one stream so axum
    // sees a single combined `Stream`.
    enum Phase {
        Upstream(Result<OpenAiChunk, Error>),
        Terminator,
    }

    // Upstream results as Phase items.
    let upstream = chunk_stream.map(Phase::Upstream);
    // The single terminator item.
    let terminator = futures::stream::once(async { Phase::Terminator });

    // Chain keeps original item order and defers terminator emission
    // until the upstream stream has fully drained.
    let combined = upstream.chain(terminator);

    // Convert each Phase into an SSE event. `Infallible` as the error
    // type because we encode upstream errors as data frames — axum's
    // Sse<Stream<Result<Event, E>>> requires an error type but we never
    // surface one.
    let body_stream = combined.map(|phase| -> Result<Event, Infallible> {
        match phase {
            Phase::Upstream(Ok(chunk)) => match encode_chunk(&chunk) {
                Ok(frame) => {
                    // `encode_chunk` wraps in `data: ... \n\n`; axum's SSE
                    // helper re-adds its own framing, so strip the prefix
                    // and trailing blank line and let axum re-emit them.
                    let json = frame
                        .strip_prefix("data: ")
                        .and_then(|s| s.strip_suffix("\n\n"))
                        .unwrap_or(&frame)
                        .to_string();
                    Ok(Event::default().data(json))
                }
                Err(_) => {
                    // Serialization shouldn't fail for well-formed chunks.
                    // If it does, emit an inline error event so the client
                    // at least sees *something* rather than a silent stall.
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

    // Silence the unused-reference lint for the standalone encoder —
    // `done_terminator` is kept for callers outside the Sse path (e.g.
    // tests, future transport implementations).
    let _ = done_terminator();

    // Axum's `Sse` helper sets Content-Type: text/event-stream and
    // handles keep-alive framing for us.
    Sse::new(body_stream).into_response()
}

/// Serialize a library error as the JSON fragment that goes on the wire
/// inside a `data:` SSE event for mid-stream failures.
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

/// Drain the chunk stream and aggregate into a single `chat.completion`
/// response.
///
/// Preserves `id` / `model` / `finish_reason` from the last chunk, since
/// the Anthropic translator emits `finish_reason` on the terminal chunk
/// only.
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
                // Unlike streaming, we haven't flushed headers yet — we
                // can still return a proper error response.
                return error_response(&err, ParseOrigin::Upstream);
            }
        }
    }

    // Fall back to sensible values for metadata. `id` falls through to a
    // deterministic stub if the upstream never sent one (unusual).
    let created = first_chunk_created.unwrap_or_else(now_epoch);
    let id = last_id.unwrap_or_else(|| "chatcmpl-unknown".to_string());
    // We echo back whatever the upstream said the model was; if it never
    // told us, echo the client's original (suffixed) model string so the
    // client sees a consistent value.
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
            },
            finish_reason,
        }],
    };

    (StatusCode::OK, Json(completion)).into_response()
}

/// Seconds-since-epoch helper — matches what the translator stamps into
/// `OpenAiChunk::created`.
fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `GET /v1/models` — stub listing.
///
/// MVP: a single hard-coded entry so OpenAI-SDK clients (which often hit
/// this endpoint at startup to validate connectivity) don't fail. The spec
/// calls for a full multi-provider listing; that lands when multi-provider
/// routing does.
pub async fn list_models() -> Json<ModelListing> {
    Json(ModelListing {
        object: "list",
        data: vec![ModelEntry {
            id: "claude-opus-4-7".to_string(),
            object: "model",
        }],
    })
}

/// OpenAI `/v1/models` shape. Kept local to the handlers since no other
/// module consumes it.
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

/// Helpers used by the unit tests in `mod tests` — exposed at module scope
/// so the tests below can reuse them.
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
                },
                finish_reason: finish.map(|s| s.to_string()),
            }],
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
        // The provider-reported model wins over the client's suffixed form
        // when the upstream populates it — same contract as the real API.
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
