//! Translator matrix: `<source_format>/<target_format>/`.
//!
//! # Why a matrix, not a hub
//!
//! The obvious design is "canonical hub" — everything goes through OpenAI
//! shape, each provider has one converter. We use something richer: a
//! matrix. Each cell translates one source shape to one target shape.
//!
//! This lets `otherside serve` accept MULTIPLE client formats (OpenAI,
//! Anthropic, Gemini native) and route to any backend — because we have
//! direct translators for each pair.
//!
//! For MVP, only `openai → anthropic` (and its reverse event stream
//! translator) exists. Others are added as needed.
//!
//! # Purity
//!
//! All translators are pure functions. No IO. No hidden state. Easy to
//! unit-test with fixtures from `fingerprint_corpus/`.
//!
//! # SSE event translators
//!
//! For each backend that streams, we have a reverse translator that
//! consumes provider-native SSE events and yields canonical
//! `chat.completion.chunk` events.
//!
//! # Modules
//!
//! - `openai_to_anthropic` — MVP request-body translation.
//! - `sse` — line-based SSE byte parser with partial-frame support.
//! - `anthropic_to_openai` — MVP response-stream event translation
//!   (Anthropic SSE events → canonical OpenAI chat.completion.chunk).
//! - (future) `openai_to_codex`, `openai_to_gemini`, etc.

pub mod anthropic_to_openai;
pub mod codex_to_openai;
pub mod openai_to_anthropic;
pub mod openai_to_codex;
pub mod sse;
