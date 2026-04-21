

use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

use crate::error::Error;

#[derive(Debug, Serialize)]
pub struct OpenAiErrorBody {
    pub error: OpenAiErrorPayload,
}

#[derive(Debug, Serialize)]
pub struct OpenAiErrorPayload {
    pub message: String,
    #[serde(rename = "type")]
    pub r#type: &'static str,
    pub code: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseOrigin {

    Request,

    Upstream,
}

pub fn error_response(err: &Error, origin: ParseOrigin) -> Response {
    let (status, ty, code, mut headers) = classify(err, origin);

    let body = OpenAiErrorBody {
        error: OpenAiErrorPayload {
            message: err.to_string(),
            r#type: ty,
            code,
        },
    };

    let mut response = (status, Json(body)).into_response();
    for (k, v) in headers.drain() {
        if let Some(name) = k {
            response.headers_mut().insert(name, v);
        }
    }
    response
}

pub fn classify(
    err: &Error,
    origin: ParseOrigin,
) -> (StatusCode, &'static str, &'static str, HeaderMap) {
    match err {
        Error::Auth(_) => (
            StatusCode::UNAUTHORIZED,
            "auth",
            "auth",
            HeaderMap::new(),
        ),
        Error::RateLimit { retry_after, .. } => {
            let mut headers = HeaderMap::new();

            if let Some(secs) = retry_after {
                if let Ok(value) = HeaderValue::from_str(&secs.as_secs().to_string()) {
                    headers.insert(header::RETRY_AFTER, value);
                }
            }
            (StatusCode::TOO_MANY_REQUESTS, "rate_limit", "rate_limit", headers)
        }
        Error::Network(_) => (
            StatusCode::BAD_GATEWAY,
            "upstream",
            "upstream",
            HeaderMap::new(),
        ),
        Error::Parse(_) | Error::Sse(_) => match origin {
            ParseOrigin::Request => (
                StatusCode::BAD_REQUEST,
                "bad_request",
                "bad_request",
                HeaderMap::new(),
            ),
            ParseOrigin::Upstream => (
                StatusCode::BAD_GATEWAY,
                "upstream",
                "upstream",
                HeaderMap::new(),
            ),
        },
        Error::Config(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal",
            HeaderMap::new(),
        ),
        Error::Other(_) | Error::Io(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal",
            HeaderMap::new(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn auth_maps_to_401() {
        let err = Error::Auth("no token".into());
        let (status, ty, code, _) = classify(&err, ParseOrigin::Request);
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(ty, "auth");
        assert_eq!(code, "auth");
    }

    #[test]
    fn rate_limit_maps_to_429_with_retry_after_header() {
        let err = Error::RateLimit {
            retry_after: Some(Duration::from_secs(42)),
            provider_message: "slow down".into(),
        };
        let (status, _, _, headers) = classify(&err, ParseOrigin::Request);
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            headers.get(header::RETRY_AFTER).and_then(|v| v.to_str().ok()),
            Some("42")
        );
    }

    #[test]
    fn rate_limit_without_retry_after_still_429() {
        let err = Error::RateLimit {
            retry_after: None,
            provider_message: "slow down".into(),
        };
        let (status, _, _, headers) = classify(&err, ParseOrigin::Request);
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert!(headers.get(header::RETRY_AFTER).is_none());
    }

    #[test]
    fn parse_request_is_400() {
        let err = Error::Parse("bad json".into());
        let (status, _, _, _) = classify(&err, ParseOrigin::Request);
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parse_upstream_is_502() {
        let err = Error::Parse("bad sse frame".into());
        let (status, _, _, _) = classify(&err, ParseOrigin::Upstream);
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn sse_upstream_is_502() {
        let err = Error::Sse("truncated".into());
        let (status, _, _, _) = classify(&err, ParseOrigin::Upstream);
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn config_is_500() {
        let err = Error::Config("boom".into());
        let (status, _, _, _) = classify(&err, ParseOrigin::Request);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn other_is_500() {
        let err = Error::Other("boom".into());
        let (status, _, _, _) = classify(&err, ParseOrigin::Request);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}
