

use serde_json::{json, Value};

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
