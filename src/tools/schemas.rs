//! Tool schema registry. Schemas are `include_str!`'d from
//! `otherside-cli/tool_corpus/*.json` so they compile into the binary
//! and cannot drift at runtime.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const READ_SCHEMA: &str = include_str!("../../tool_corpus/read.json");
const GLOB_SCHEMA: &str = include_str!("../../tool_corpus/glob.json");
const GREP_SCHEMA: &str = include_str!("../../tool_corpus/grep.json");
const TASK_SCHEMA: &str = include_str!("../../tool_corpus/task.json");

/// Loaded tool schema. Public so the translator can serialize it into
/// the outbound Anthropic request's `tools` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

fn load_all() -> Vec<ToolSchema> {
    [READ_SCHEMA, GLOB_SCHEMA, GREP_SCHEMA, TASK_SCHEMA]
        .into_iter()
        .map(|s| serde_json::from_str(s).expect("bundled tool_corpus JSON is well-formed"))
        .collect()
}

/// All known tool schemas, loaded once.
pub fn tool_schemas() -> &'static [ToolSchema] {
    static SCHEMAS: OnceLock<Vec<ToolSchema>> = OnceLock::new();
    SCHEMAS.get_or_init(load_all).as_slice()
}

/// Look up a schema by tool name.
pub fn schema_for(name: &str) -> Option<&'static ToolSchema> {
    tool_schemas().iter().find(|s| s.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_four_schemas_loaded() {
        let all = tool_schemas();
        assert_eq!(all.len(), 4);
    }

    #[test]
    fn read_schema_has_required_file_path() {
        let s = schema_for("Read").unwrap();
        assert_eq!(s.name, "Read");
        assert!(s.description.contains("Reads a file"));
        let required = s.input_schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "file_path"));
    }

    #[test]
    fn glob_schema_has_pattern_required() {
        let s = schema_for("Glob").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "pattern"));
    }

    #[test]
    fn grep_schema_has_pattern_required() {
        let s = schema_for("Grep").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "pattern"));
    }

    #[test]
    fn task_schema_requires_description_and_prompt() {
        let s = schema_for("Task").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.contains(&"description"));
        assert!(names.contains(&"prompt"));
    }
}
