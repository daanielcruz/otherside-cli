//! `openai → anthropic` request-body translation shim.
//!
//! As of openspec 001 phase R-34, the final `/v1/messages` body is
//! assembled in exactly one place: [`crate::harness::assembly`]. That
//! module centralizes every conditional that shapes the outgoing
//! request so an auditor reading a single file sees every branch.
//!
//! This module retains:
//!
//! - The two typed-Anthropic helper submodules the assembler calls
//!   into: [`blocks`] (block kinds + cache marker helpers) and
//!   [`message_builder`] (normalize + add_cache_breakpoints).
//! - Public re-exports of [`build_request_body`], [`UserContext`],
//!   [`strip_1m_suffix`] for existing callers (`provider::anthropic`
//!   and friends). The authoritative definitions live in
//!   `harness::assembly`.

pub mod blocks;
pub mod message_builder;

pub use crate::harness::assembly::{build_request_body, strip_1m_suffix, UserContext};
