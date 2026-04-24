pub use crate::harness::TOOL_SEND_MESSAGE_JSON;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn schema_parses_as_json() {
        let _: Value = serde_json::from_str(TOOL_SEND_MESSAGE_JSON).unwrap();
    }

    #[test]
    fn schema_requires_to_and_message() {
        let v: Value = serde_json::from_str(TOOL_SEND_MESSAGE_JSON).unwrap();
        let required = v["input_schema"]["required"].as_array().unwrap();
        let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.contains(&"to"));
        assert!(names.contains(&"message"));
    }
}
