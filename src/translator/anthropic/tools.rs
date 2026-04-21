

use serde_json::Value;

use crate::harness::{
    TOOL_AGENT_JSON, TOOL_BASH_JSON, TOOL_EDIT_JSON, TOOL_GLOB_JSON, TOOL_GREP_JSON,
    TOOL_READ_JSON, TOOL_SKILL_JSON, TOOL_TOOL_SEARCH_JSON, TOOL_WRITE_JSON,
};

pub fn build_tools_array() -> Vec<Value> {
    [
        TOOL_AGENT_JSON,
        TOOL_BASH_JSON,
        TOOL_EDIT_JSON,
        TOOL_GLOB_JSON,
        TOOL_GREP_JSON,
        TOOL_READ_JSON,
        TOOL_SKILL_JSON,
        TOOL_TOOL_SEARCH_JSON,
        TOOL_WRITE_JSON,
    ]
    .into_iter()
    .map(|raw| serde_json::from_str(raw).expect("bundled tool schema is well-formed JSON"))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_nine_tools_in_canonical_order() {
        let tools = build_tools_array();
        assert_eq!(tools.len(), 9);
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().expect("tool has a name"))
            .collect();
        assert_eq!(names, crate::harness::TOOL_ORDER.to_vec());
    }

    #[test]
    fn every_tool_has_name_description_input_schema() {
        let tools = build_tools_array();
        for t in tools.iter() {
            assert!(t["name"].is_string());
            assert!(t["description"].is_string());
            assert!(t["input_schema"].is_object());
        }
    }

    #[test]
    fn training_anchor_tool_names_preserved() {

        let tools = build_tools_array();
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        for anchor in ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"] {
            assert!(names.contains(&anchor), "missing anchor: {anchor}");
        }
    }
}
