//! Unified error type for otherside.
//!
//! Two layers of error handling, matching C19:
//!
//! - **Library-level (thiserror):** typed, structured errors emitted by
//!   library code (auth, inference, translator). These are the vocabulary
//!   the library exposes to callers. They have `From` conversions to/from
//!   common source errors (serde_json, reqwest, etc.).
//!
//! - **App-level (anyhow):** the main binary wraps library errors in
//!   `anyhow::Error` for user-facing display. CLI exit codes are derived
//!   from the library-level variant via [`Error::exit_code`].
//!
//! # CLI exit codes (see `openspec/specs/cli/spec.md` — Requirement: Structured Exit Codes)
//!
//! - `10` — auth error (no credentials, refresh failed)
//! - `20` — network error (connection refused, TLS failure)
//! - `30` — rate limit error (HTTP 429)
//! - `1`  — any other error (generic failure)

use std::time::Duration;

use thiserror::Error;

/// The library-level error vocabulary.
///
/// Variants are intentionally narrow: if the library returns `Error::Auth`,
/// the caller knows to suggest `otherside login`. If it returns
/// `Error::RateLimit`, the caller may surface `retry_after` to the user.
#[derive(Debug, Error)]
pub enum Error {
    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("rate limit exceeded{retry_after:?}")]
    RateLimit {
        retry_after: Option<Duration>,
        provider_message: String,
    },

    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("malformed response: {0}")]
    Parse(String),

    #[error("malformed SSE stream: {0}")]
    Sse(String),

    #[error("config error: {0}")]
    Config(String),

    #[error("{0}")]
    Other(String),
}

impl Error {
    /// CLI exit code corresponding to this error variant.
    ///
    /// Used by the binary to map errors to documented exit codes.
    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Auth(_) => 10,
            Error::Network(_) => 20,
            Error::RateLimit { .. } => 30,
            _ => 1,
        }
    }
}

/// Convenience alias for internal `Result`.
pub type Result<T> = std::result::Result<T, Error>;
