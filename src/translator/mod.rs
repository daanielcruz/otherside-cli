//! Translator matrix: OpenAI-shape ↔ provider-native formats.
//!
//! `harness/` emits OpenAI `ChatCompletionRequest` shape. Each provider
//! subdirectory owns two halves of the matrix:
//!
//! - `request.rs` — OpenAI chat request → provider-native wire body.
//! - `response.rs` — provider-native streaming events → canonical
//!   `chat.completion.chunk` events the inner agent loop consumes.
//!
//! `sse.rs` is a shared line-based SSE byte parser used by every
//! provider's `response.rs`.
//!
//! # Active submodules
//!
//! - `anthropic/` — OpenAI → `/v1/messages` body + Anthropic SSE →
//!   OpenAI stream chunks. This is the MVP path; all byte-fidelity
//!   tests live here.
//! - `codex/` — OpenAI → `/v1/responses` body + event translator.
//!   Dispatch frozen per the provider-freeze directive (user-facing
//!   selector live, wire-level translator NOT wired through
//!   `provider::dispatch`). Kept in source so when the freeze lifts
//!   the module is already in place.
//! - `gemini/` — stub. Frozen.
//! - `openai_custom/` — stub. Frozen.
//!
//! # Purity
//!
//! Every function is pure: no IO, no hidden state. Fixtures under
//! `fingerprint_corpus/` drive unit tests.

pub mod anthropic;
pub mod codex;
pub mod gemini;
pub mod openai_custom;
pub mod sse;
