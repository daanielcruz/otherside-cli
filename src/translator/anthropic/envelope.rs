

use serde_json::Value;

pub fn build_envelope_defaults() -> Value {
    serde_json::from_str(crate::harness::ENVELOPE_JSON)
        .expect("bundled envelope.json is well-formed")
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
