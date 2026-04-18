//! Tool schema registry. Schemas are `include_str!`'d from
//! `otherside-cli/tool_corpus/*.json` so they compile into the binary
//! and cannot drift at runtime.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::inference::{OpenAiFunctionDef, OpenAiToolDef};

const READ_SCHEMA: &str = include_str!("../../tool_corpus/read.json");
const GLOB_SCHEMA: &str = include_str!("../../tool_corpus/glob.json");
const GREP_SCHEMA: &str = include_str!("../../tool_corpus/grep.json");
const TASK_SCHEMA: &str = include_str!("../../tool_corpus/task.json");
const BASH_SCHEMA: &str = include_str!("../../tool_corpus/bash.json");
const BASHOUTPUT_SCHEMA: &str = include_str!("../../tool_corpus/bashoutput.json");
const KILLBASH_SCHEMA: &str = include_str!("../../tool_corpus/killbash.json");
const EDIT_SCHEMA: &str = include_str!("../../tool_corpus/edit.json");
const WRITE_SCHEMA: &str = include_str!("../../tool_corpus/write.json");

/// Loaded tool schema. Public so the translator can serialize it into
/// the outbound Anthropic request's `tools` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

fn load_all() -> Vec<ToolSchema> {
    [
        READ_SCHEMA,
        GLOB_SCHEMA,
        GREP_SCHEMA,
        TASK_SCHEMA,
        BASH_SCHEMA,
        BASHOUTPUT_SCHEMA,
        KILLBASH_SCHEMA,
        EDIT_SCHEMA,
        WRITE_SCHEMA,
    ]
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

/// Convert every registered tool schema into the OpenAI-canonical tool
/// definition shape the inference request carries. Call once per turn
/// when building the request; cost is negligible (9 small clones).
pub fn openai_tools() -> Vec<OpenAiToolDef> {
    tool_schemas()
        .iter()
        .map(|s| OpenAiToolDef {
            kind: "function".to_string(),
            function: OpenAiFunctionDef {
                name: s.name.clone(),
                description: s.description.clone(),
                parameters: s.input_schema.clone(),
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_schemas_loaded() {
        let all = tool_schemas();
        assert_eq!(all.len(), 9);
    }

    #[test]
    fn edit_and_write_names_preserved() {
        assert_eq!(schema_for("Edit").unwrap().name, "Edit");
        assert_eq!(schema_for("Write").unwrap().name, "Write");
    }

    #[test]
    fn bash_family_names_preserved_verbatim() {
        // R-20 training anchors. Renames here are catastrophic.
        assert_eq!(schema_for("Bash").unwrap().name, "Bash");
        assert_eq!(schema_for("BashOutput").unwrap().name, "BashOutput");
        assert_eq!(schema_for("KillBash").unwrap().name, "KillBash");
    }

    #[test]
    fn bash_schema_required_fields() {
        let s = schema_for("Bash").unwrap();
        let req = s.input_schema["required"].as_array().unwrap();
        assert!(req.iter().any(|v| v == "command"));
    }

    #[test]
    fn bashoutput_schema_required_fields() {
        let s = schema_for("BashOutput").unwrap();
        let req = s.input_schema["required"].as_array().unwrap();
        assert!(req.iter().any(|v| v == "bash_id"));
    }

    #[test]
    fn killbash_schema_required_fields() {
        let s = schema_for("KillBash").unwrap();
        let req = s.input_schema["required"].as_array().unwrap();
        assert!(req.iter().any(|v| v == "shell_id"));
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

    #[test]
    fn openai_tools_round_trip_all_schemas() {
        let tools = openai_tools();
        assert_eq!(tools.len(), 9);
        for (lhs, rhs) in tool_schemas().iter().zip(tools.iter()) {
            assert_eq!(rhs.kind, "function");
            assert_eq!(rhs.function.name, lhs.name);
            assert_eq!(rhs.function.description, lhs.description);
            assert_eq!(rhs.function.parameters, lhs.input_schema);
        }
    }

    #[test]
    fn openai_tools_preserves_training_anchors() {
        let tools = openai_tools();
        let names: Vec<&str> = tools.iter().map(|t| t.function.name.as_str()).collect();
        for anchor in ["Read", "Glob", "Grep", "Bash", "BashOutput",
                       "KillBash", "Edit", "Write", "Task"] {
            assert!(names.contains(&anchor), "missing training anchor: {anchor}");
        }
    }
}
