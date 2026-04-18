//! otherside — library surface.
//!
//! This is the shared core that both the `otherside` binary (interactive CLI)
//! and the future `otherside serve` (OpenAI-compat HTTP server) build on.
//!
//! # Why a library crate
//!
//! We split into `lib` + `bin` so integration tests in `tests/` can consume
//! our public types (the translator, the fingerprint profiles, the config
//! loader) without having to re-invoke the binary and parse stdout. This
//! matters for the conformance tests (C36): they load captured corpus from
//! `fingerprint_corpus/<scenario>/` and byte-diff against what our Rust code
//! produces when called directly.
//!
//! # Module overview
//!
//! - [`config`] — `~/.otherside/settings.json` schema and loader.
//! - [`error`] — unified error type used across the crate.
//! - [`thinking`] — unified thinking/reasoning concept type (ThinkingConfig,
//!   Level enum) and the model-name suffix parser (e.g. `claude-opus-4-7(xhigh)`).
//! - [`fingerprint`] — HTTP fingerprint profiles per provider. This is the
//!   ONE place in the crate where otherside impersonates the upstream CLI.
//!   Rest of the code doesn't know.
//! - [`inference`] — canonical OpenAI chat shapes. Agent-side types.
//! - [`auth`] — OAuth flows per provider + token cache.
//! - [`provider`] — `Provider` trait + registry + per-provider impls.
//! - [`translator`] — the matrix: `openai → anthropic`, etc. Pure functions.
//!
//! # Impersonation rule (see memory `project_otherside_fingerprint_impersonation`)
//!
//! Every outbound HTTP request to a provider endpoint goes through a
//! fingerprint profile that sets the exact User-Agent, header set, and body
//! shape of the upstream CLI. There is no "honest" otherside fingerprint.
//! This is a conscious design choice (D6 + C33-C36): features are gated
//! server-side by fingerprint; diverging means silent feature loss.

pub mod agent;
pub mod auth;
pub mod config;
pub mod error;
pub mod fingerprint;
pub mod hooks;
pub mod inference;
pub mod permissions;
pub mod provider;
pub mod sessions;
pub mod serve;
pub mod statusline;
pub mod thinking;
// keep modules ordered; sessions added above alongside permissions.
pub mod tools;
pub mod translator;
pub mod tui;
