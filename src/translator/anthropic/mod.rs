//! Anthropic translator — OpenAI chat request shape ↔ Anthropic
//! `/v1/messages` body and SSE event stream.
//!
//! Modules:
//! - `request` — OpenAI `ChatCompletionRequest` → `/v1/messages` body.
//! - `response` — Anthropic SSE events → canonical OpenAI
//!   `chat.completion.chunk`.
//! - `blocks` — content-block helpers used by request.
//! - `message_builder` — two-stage normalize + cache-breakpoint pass.

pub mod blocks;
pub mod message_builder;
pub mod request;
pub mod response;

// Re-export the surface previous call sites imported from the old
// `openai_to_anthropic` module so the migration is one-line in each
// consumer file.
pub use request::*;
pub use response::*;
