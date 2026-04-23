

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::inference::{OpenAiFunctionDef, OpenAiToolDef};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

fn load_all() -> Vec<ToolSchema> {
    crate::translator::anthropic::tools::build_tools_array()
        .into_iter()
        .map(|v| {
            serde_json::from_value(v).expect("harness tool Value deserializes into ToolSchema")
        })
        .collect()
}

pub fn tool_schemas() -> &'static [ToolSchema] {
    static SCHEMAS: OnceLock<Vec<ToolSchema>> = OnceLock::new();
    SCHEMAS.get_or_init(load_all).as_slice()
}

fn load_deferred() -> Vec<ToolSchema> {

    let raws: &[&str] = &[
        crate::tools::task::TOOL_TASK_CREATE_JSON,
        crate::tools::task::TOOL_TASK_LIST_JSON,
        crate::tools::task::TOOL_TASK_GET_JSON,
        crate::tools::task::TOOL_TASK_UPDATE_JSON,
        crate::tools::notebook::TOOL_NOTEBOOK_EDIT_JSON,
        crate::tools::web_fetch::TOOL_WEB_FETCH_JSON,
        crate::tools::web_search::TOOL_WEB_SEARCH_JSON,
        crate::tools::plan_mode::TOOL_ENTER_PLAN_MODE_JSON,
        crate::tools::plan_mode::TOOL_EXIT_PLAN_MODE_JSON,
        crate::tools::worktree::TOOL_ENTER_WORKTREE_JSON,
        crate::tools::worktree::TOOL_EXIT_WORKTREE_JSON,
        crate::tools::task::TOOL_TASK_OUTPUT_JSON,
        crate::tools::task::TOOL_TASK_STOP_JSON,
        crate::tools::cron::TOOL_CRON_CREATE_JSON,
        crate::tools::cron::TOOL_CRON_DELETE_JSON,
        crate::tools::cron::TOOL_CRON_LIST_JSON,
        crate::tools::cron::TOOL_SCHEDULE_WAKEUP_JSON,
        crate::tools::ask_user_question::TOOL_ASK_USER_QUESTION_JSON,
    ];
    raws.iter()
        .map(|raw| {
            serde_json::from_str::<ToolSchema>(raw)
                .expect("bundled deferred tool schema is well-formed JSON")
        })
        .collect()
}

pub fn deferred_schemas() -> &'static [ToolSchema] {
    static SCHEMAS: OnceLock<Vec<ToolSchema>> = OnceLock::new();
    SCHEMAS.get_or_init(load_deferred).as_slice()
}

pub fn all_schemas() -> &'static [ToolSchema] {
    static SCHEMAS: OnceLock<Vec<ToolSchema>> = OnceLock::new();
    SCHEMAS
        .get_or_init(|| {
            let mut v: Vec<ToolSchema> = tool_schemas().to_vec();
            v.extend(deferred_schemas().iter().cloned());
            v
        })
        .as_slice()
}

pub fn schema_for(name: &str) -> Option<&'static ToolSchema> {
    all_schemas().iter().find(|s| s.name == name)
}

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
    fn canonical_order_matches_harness() {
        let names: Vec<&str> = tool_schemas().iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"]
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
    fn bash_schema_keeps_command_required() {
        let s = schema_for("Bash").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "command"));
    }

    #[test]
    fn bash_schema_carries_run_in_background_property() {

        let s = schema_for("Bash").unwrap();
        assert!(s.input_schema["properties"]
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

    #[test]
    fn wire_schemas_remain_exactly_nine() {

        assert_eq!(tool_schemas().len(), 9);
    }

    #[test]
    fn deferred_schemas_contain_wave_3_set() {

        assert_eq!(deferred_schemas().len(), 18);
    }

    #[test]
    fn deferred_schema_names_match_current_waves() {
        let names: Vec<&str> = deferred_schemas().iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "TaskCreate",
                "TaskList",
                "TaskGet",
                "TaskUpdate",
                "NotebookEdit",
                "WebFetch",
                "WebSearch",
                "EnterPlanMode",
                "ExitPlanMode",
                "EnterWorktree",
                "ExitWorktree",
                "TaskOutput",
                "TaskStop",
                "CronCreate",
                "CronDelete",
                "CronList",
                "ScheduleWakeup",
                "AskUserQuestion",
            ]
        );
    }

    #[test]
    fn all_schemas_total_reflects_every_wave() {

        assert_eq!(all_schemas().len(), 27);
    }

    #[test]
    fn all_schemas_wire_first_ordering() {
        let names: Vec<&str> = all_schemas().iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            &names[..9],
            &["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"]
        );
        assert_eq!(
            &names[9..],
            &[
                "TaskCreate",
                "TaskList",
                "TaskGet",
                "TaskUpdate",
                "NotebookEdit",
                "WebFetch",
                "WebSearch",
                "EnterPlanMode",
                "ExitPlanMode",
                "EnterWorktree",
                "ExitWorktree",
                "TaskOutput",
                "TaskStop",
                "CronCreate",
                "CronDelete",
                "CronList",
                "ScheduleWakeup",
                "AskUserQuestion",
            ]
        );
    }

    #[test]
    fn schema_for_resolves_deferred_names() {
        assert!(schema_for("TaskCreate").is_some());
        assert!(schema_for("TaskList").is_some());
        assert!(schema_for("TaskGet").is_some());
        assert!(schema_for("TaskUpdate").is_some());
        assert!(schema_for("NotebookEdit").is_some());
        assert!(schema_for("WebFetch").is_some());
        assert!(schema_for("WebSearch").is_some());
    }

    #[test]
    fn web_fetch_schema_requires_url_and_prompt() {
        let s = schema_for("WebFetch").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.contains(&"url"));
        assert!(names.contains(&"prompt"));
    }

    #[test]
    fn web_search_schema_requires_query_only() {
        let s = schema_for("WebSearch").unwrap();
        let required = s.input_schema["required"].as_array().unwrap();
        let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(names, vec!["query"]);

        let props = s.input_schema["properties"].as_object().unwrap();
        assert!(props.contains_key("allowed_domains"));
        assert!(props.contains_key("blocked_domains"));
    }

    #[test]
    fn openai_tools_excludes_deferred_schemas() {
        let names: Vec<String> = openai_tools()
            .iter()
            .map(|t| t.function.name.clone())
            .collect();
        for deferred in [
            "TaskCreate",
            "TaskList",
            "TaskGet",
            "TaskUpdate",
            "NotebookEdit",
            "WebFetch",
            "WebSearch",
        ] {
            assert!(
                !names.iter().any(|n| n == deferred),
                "deferred tool `{deferred}` must NOT appear in the wire `openai_tools()` list"
            );
        }
    }
}
