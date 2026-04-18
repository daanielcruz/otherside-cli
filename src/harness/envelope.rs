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

use serde_json::Value;

use super::ENVELOPE_JSON;

/// Parse the bundled envelope defaults into a fresh `Value::Object`
/// with preserved key order.
///
/// Called per request; parse cost is negligible (~425 bytes) and a
/// fresh copy lets callers mutate without aliasing.
pub fn build_envelope_defaults() -> Value {
    serde_json::from_str(ENVELOPE_JSON).expect("bundled envelope.json is well-formed")
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
