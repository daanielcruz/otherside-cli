

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
        crate::tools::send_message::TOOL_SEND_MESSAGE_JSON,
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
    let mut out: Vec<OpenAiToolDef> = tool_schemas()
        .iter()
        .map(|s| OpenAiToolDef {
            kind: "function".to_string(),
            function: OpenAiFunctionDef {
                name: s.name.clone(),
                description: s.description.clone(),
                parameters: s.input_schema.clone(),
            },
        })
        .collect();

    let announced = crate::tools::deferred_registry::current();
    if announced.is_empty() {
        return out;
    }
    let base_names: std::collections::HashSet<String> =
        out.iter().map(|t| t.function.name.clone()).collect();
    for name in announced {
        if base_names.contains(&name) {
            continue;
        }
        if let Some(s) = schema_for(&name) {
            out.push(OpenAiToolDef {
                kind: "function".to_string(),
                function: OpenAiFunctionDef {
                    name: s.name.clone(),
                    description: s.description.clone(),
                    parameters: s.input_schema.clone(),
                },
            });
        }
    }
    out
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
    fn wire_schemas_required_fields_match_upstream() {
        let cases: &[(&str, &[&str])] = &[
            ("Bash", &["command"]),
            ("Read", &["file_path"]),
            ("Glob", &["pattern"]),
            ("Grep", &["pattern"]),
            ("Agent", &["description", "prompt"]),
            ("Skill", &["skill"]),
            ("ToolSearch", &["query"]),
        ];
        for (name, expected) in cases {
            let s = schema_for(name).unwrap_or_else(|| panic!("missing schema: {name}"));
            let required: Vec<&str> = s.input_schema["required"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            for field in *expected {
                assert!(
                    required.contains(field),
                    "{name} schema missing required field `{field}` (got {required:?})"
                );
            }
        }
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
    fn openai_tools_round_trip_all_schemas() {
        crate::tools::deferred_registry::clear();
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
                "SendMessage",
            ]
        );
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
                "SendMessage",
            ]
        );
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
    fn openai_tools_excludes_deferred_schemas_when_registry_empty() {

        crate::tools::deferred_registry::clear();
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
                "deferred tool `{deferred}` must NOT appear in wire list until ToolSearch announces it"
            );
        }
    }

    #[test]
    fn openai_tools_includes_deferred_after_announce() {

        crate::tools::deferred_registry::clear();
        let before: Vec<String> = openai_tools().iter().map(|t| t.function.name.clone()).collect();
        assert!(!before.iter().any(|n| n == "WebSearch"));

        crate::tools::deferred_registry::announce("WebSearch");
        let after: Vec<String> = openai_tools().iter().map(|t| t.function.name.clone()).collect();
        assert!(
            after.iter().any(|n| n == "WebSearch"),
            "after ToolSearch announces WebSearch, wire list must include it so the model can actually call it: {after:?}"
        );
        crate::tools::deferred_registry::clear();
    }

    #[test]
    fn openai_tools_does_not_duplicate_base_tools_after_announce() {
        crate::tools::deferred_registry::clear();
        crate::tools::deferred_registry::announce("Bash");
        let names: Vec<String> = openai_tools().iter().map(|t| t.function.name.clone()).collect();
        let bash_count = names.iter().filter(|n| *n == "Bash").count();
        assert_eq!(bash_count, 1, "base tool Bash must not be duplicated when announced");
        crate::tools::deferred_registry::clear();
    }
}
