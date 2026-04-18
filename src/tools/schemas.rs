//! Tool schema registry sourced from `harness::build_tools_array`.
//!
//! 010 flipped the source of truth: schemas previously lived as
//! hand-transcribed JSON under `otherside-cli/tool_corpus/`; that
//! directory is retired. Today every advertised schema comes from
//! `fingerprint_corpus/harness/tools/<Name>.json` (byte-matched against
//! capture — see change 009's `tests/harness_artifacts.rs`) and flows
//! through the harness builder at compile time.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::harness;
use crate::inference::{OpenAiFunctionDef, OpenAiToolDef};

/// Loaded tool schema. Deserialized from a captured `Value`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

fn load_all() -> Vec<ToolSchema> {
    harness::tools::build_tools_array()
        .into_iter()
        .map(|v| {
            serde_json::from_value(v)
                .expect("harness tool Value deserializes into ToolSchema")
        })
        .collect()
}

/// All advertised tool schemas, loaded once. Canonical order:
/// Agent, Bash, Edit, Glob, Grep, Read, Skill, ToolSearch, Write.
pub fn tool_schemas() -> &'static [ToolSchema] {
    static SCHEMAS: OnceLock<Vec<ToolSchema>> = OnceLock::new();
    SCHEMAS.get_or_init(load_all).as_slice()
}

/// Look up a schema by tool name.
pub fn schema_for(name: &str) -> Option<&'static ToolSchema> {
    tool_schemas().iter().find(|s| s.name == name)
}

/// Convert every registered tool schema into the OpenAI-canonical tool
/// definition shape.
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
    fn exactly_nine_advertised_schemas() {
        assert_eq!(tool_schemas().len(), 9);
    }

    #[test]
    fn canonical_order_matches_harness() {
        let names: Vec<&str> = tool_schemas().iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Agent",
                "Bash",
                "Edit",
                "Glob",
                "Grep",
                "Read",
                "Skill",
                "ToolSearch",
                "Write"
            ]
        );
    }

    #[test]
    fn training_anchors_present() {
        for anchor in [
            "Agent",
            "Bash",
            "Edit",
            "Glob",
            "Grep",
            "Read",
            "Skill",
            "ToolSearch",
            "Write",
        ] {
            assert!(
                schema_for(anchor).is_some(),
                "missing training anchor: {anchor}"
            );
        }
    }

    #[test]
    fn retired_tool_names_absent() {
        // Task was the pre-010 name for Agent; BashOutput/KillBash are
        // now internal-only helpers inside the Bash dispatch path.
        assert!(schema_for("Task").is_none());
        assert!(schema_for("BashOutput").is_none());
        assert!(schema_for("KillBash").is_none());
    }

    #[test]
    fn bash_schema_keeps_command_required() {
        let s = schema_for("Bash").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "command"));
    }

    #[test]
    fn bash_schema_carries_run_in_background_property() {
        // run_in_background subsumes what BashOutput/KillBash used to
        // handle via separate tool names.
        let s = schema_for("Bash").unwrap();
        assert!(s
            .input_schema["properties"]
            .as_object()
            .unwrap()
            .contains_key("run_in_background"));
    }

    #[test]
    fn read_schema_has_required_file_path() {
        let s = schema_for("Read").unwrap();
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
    fn agent_schema_requires_description_and_prompt() {
        let s = schema_for("Agent").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.contains(&"description"));
        assert!(names.contains(&"prompt"));
    }

    #[test]
    fn skill_schema_requires_skill_name() {
        let s = schema_for("Skill").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "skill"));
    }

    #[test]
    fn tool_search_schema_requires_query() {
        let s = schema_for("ToolSearch").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "query"));
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
}
