//! OpenAI → Anthropic `/v1/messages` request translation.
//!
//! Thin re-export shim: the authoritative implementation lives in
//! `crate::harness::assembly` per R-34 (single-assembly-file rule).
//! Typed helpers used by that assembler live in sibling modules
//! `blocks` (block kinds + cache markers) and `message_builder`
//! (normalize + add_cache_breakpoints).

pub use crate::harness::assembly::{build_request_body, strip_1m_suffix, UserContext};
