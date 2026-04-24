

use serde_json::Value;

pub fn build_envelope_defaults() -> Value {
    serde_json::from_str(crate::harness::ENVELOPE_JSON)
        .expect("bundled envelope.json is well-formed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_matches_captured_wire_shape() {
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
        assert_eq!(env["max_tokens"], 64000);
        assert_eq!(env["thinking"]["type"], "adaptive");
        assert_eq!(env["stream"], true);
    }
}
