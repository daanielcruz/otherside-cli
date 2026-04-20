//! Envelope defaults for the outbound body.
//!
//! Captures everything the body carries at the top level EXCEPT
//! request-specific fields (`model`, `messages`, `system`, `tools`,
//! `tool_choice`). Translator layer splices the request-specific fields
//! around these defaults.
//!
//! Key order from capture (verified 2026-04-18):
//! `metadata, max_tokens, thinking, context_management, output_config, stream`.
//!
//! `metadata.user_id` in the captured JSON is a stringified inner JSON
//! with `device_id / account_uuid / session_id` fields — those are
//! upstream's opaque identity payload, scrubbed in the capture to
//! `XXX_*_XXX` placeholders. The translator replaces them with the
//! session's real values before emission.

use serde_json::{json, Value};

/// Build the top-level envelope defaults. Key order is load-bearing —
/// the capture emits `metadata, max_tokens, thinking,
/// context_management, output_config, stream` in that exact order.
/// `serde_json::json!` preserves insertion order when the
/// `preserve_order` feature is on (R-56), so this literal doubles as
/// the canonical wire-shape contract.
///
/// `metadata.user_id` is a stringified inner JSON carrying opaque
/// identity placeholders (device_id / account_uuid / session_id).
/// The translator rewrites them with session values before emission.
pub fn build_envelope_defaults() -> Value {
    json!({
        "metadata": {
            "user_id": "{\"device_id\":\"XXX_DEVICE_ID_XXX\",\"account_uuid\":\"XXX_ACCOUNT_UUID_XXX\",\"session_id\":\"XXX_SESSION_ID_XXX\"}"
        },
        "max_tokens": 64000,
        "thinking": {
            "type": "adaptive"
        },
        "context_management": {
            "edits": [
                {
                    "type": "clear_thinking_20251015",
                    "keep": "all"
                }
            ]
        },
        "output_config": {
            "effort": "xhigh"
        },
        "stream": true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_expected_top_level_keys_in_order() {
        let env = build_envelope_defaults();
        let obj = env.as_object().expect("envelope is an object");
        let keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "metadata",
                "max_tokens",
                "thinking",
                "context_management",
                "output_config",
                "stream",
            ]
        );
    }

    #[test]
    fn max_tokens_is_capture_value() {
        let env = build_envelope_defaults();
        assert_eq!(env["max_tokens"], 64000);
    }

    #[test]
    fn thinking_type_is_adaptive() {
        let env = build_envelope_defaults();
        assert_eq!(env["thinking"]["type"], "adaptive");
    }

    #[test]
    fn stream_is_true() {
        let env = build_envelope_defaults();
        assert_eq!(env["stream"], true);
    }
}
