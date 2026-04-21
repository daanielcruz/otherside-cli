pub const TOOL_ASK_USER_QUESTION_JSON: &str =
    include_str!("../../../harness_corpus/tools/AskUserQuestion.json");

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn schema_parses_as_json() {
        let _: Value = serde_json::from_str(TOOL_ASK_USER_QUESTION_JSON).unwrap();
    }
}
