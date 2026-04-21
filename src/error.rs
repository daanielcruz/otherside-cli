

use std::time::Duration;

use thiserror::Error;

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

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("header error: {0}")]
    Header(String),

    #[error("tui error: {0}")]
    Tui(String),

    #[error("oauth exchange ({provider}): {detail}")]
    OauthExchange { provider: &'static str, detail: String },

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

    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Auth(_) => 10,
            Error::Network(_) => 20,
            Error::RateLimit { .. } => 30,
            _ => 1,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
