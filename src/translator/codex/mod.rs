//! Codex translator — OpenAI chat request shape ↔ OpenAI
//! `/v1/responses` body (Codex uses OpenAI's newer Responses API,
//! not Chat Completions). Paired with ChatGPT OAuth.
//!
//! Dispatch is frozen per the provider-freeze directive — the user-
//! facing Provider selector surfaces this provider in the Config tab,
//! but `provider::dispatch` does NOT route to it yet.
//!
//! Modules:
//! - `request` — OpenAI chat → `/v1/responses` body.
//! - `response` — OpenAI Responses SSE → canonical chunks.

pub mod request;
pub mod response;

pub use request::*;
pub use response::*;
