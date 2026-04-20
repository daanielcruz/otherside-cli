//! External-API tools — `WebSearch`, `WebFetch`. Schema is shared
//! across providers (model sees the same tool surface regardless of
//! which provider drives the session); dispatch routes to a provider-
//! specific backend at call time based on `ProviderId`.
//!
//! Per-tool layout:
//!
//! ```text
//! web_search/
//!   mod.rs           schema export + dispatch(args, provider) router
//!   claude_code.rs   backend when claude-code is active
//!   codex.rs         stub, dispatch frozen
//!   gemini.rs        stub, dispatch frozen
//! ```
//!
//! Schema lives ONCE under `harness_corpus/tools/<Tool>.json` — the
//! model never sees which provider will handle the call. Callers use
//! `crate::tools::api::web_search::dispatch(args, provider_id)` and the
//! backend selection stays invisible to the inner agent loop.

pub mod web_fetch;
pub mod web_search;
