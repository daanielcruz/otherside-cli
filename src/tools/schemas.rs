//! Tool schema registry — two catalogs:
//!
//! - **Wire catalog** (`tool_schemas`): the 9 tools advertised on the
//!   outbound `tools[]` body. Byte-locked to capture via
//!   `harness::tools::build_tools_array()` → `fingerprint_corpus/harness/
//!   tools/<Name>.json`. Only `openai_tools()` reads this surface so the
//!   byte-match chain (`tests/harness_artifacts.rs`) stays frozen.
//! - **Deferred catalog** (`deferred_schemas`): tools the model loads on
//!   demand through `ToolSearch` (matches upstream's deferred-tools
//!   reminder at `harness_corpus/system-reminders/deferred-tools.txt`).
//!   Schemas are otherside-native — synthesized from upstream Zod shapes
//!   since our live capture did not exercise `ToolSearch`. Swap to
//!   byte-verbatim when a real capture lands.
//!
//! `all_schemas()` concatenates the two in wire-first order. `ToolSearch`
//! reads `all_schemas()`; `openai_tools()` reads `tool_schemas()`. The
//! split is load-bearing: deferred schemas MUST NOT leak into the wire
//! body or the capture-anchor conformance suite breaks.
//!
//! 010 flipped the source of truth for the wire catalog: schemas used to
//! live as hand-transcribed JSON under `otherside-cli/tool_corpus/`; that
//! directory is retired. 018 added the deferred catalog on top without
//! disturbing the wire chain.

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
            serde_json::from_value(v).expect("harness tool Value deserializes into ToolSchema")
        })
        .collect()
}

/// All WIRE-advertised tool schemas, loaded once. Canonical order:
/// Agent, Bash, Edit, Glob, Grep, Read, Skill, ToolSearch, Write. This
/// is the list `openai_tools()` serializes into the outbound `tools[]`
/// body — deferred schemas MUST NOT land here.
pub fn tool_schemas() -> &'static [ToolSchema] {
    static SCHEMAS: OnceLock<Vec<ToolSchema>> = OnceLock::new();
    SCHEMAS.get_or_init(load_all).as_slice()
}

fn load_deferred() -> Vec<ToolSchema> {
    // Deferred schemas are otherside-native (see module docstring).
    // When live capture records a real `ToolSearch` response for any
    // of these names, swap the backing const in its source module.
    let raws: &[&str] = &[
        crate::tools::task::TOOL_TASK_CREATE_JSON,
        crate::tools::task::TOOL_TASK_LIST_JSON,
        crate::tools::task::TOOL_TASK_GET_JSON,
        crate::tools::task::TOOL_TASK_UPDATE_JSON,
        crate::tools::notebook::TOOL_NOTEBOOK_EDIT_JSON,
        crate::tools::web_fetch::TOOL_WEB_FETCH_JSON,
        crate::tools::web_search::TOOL_WEB_SEARCH_JSON,
        crate::tools::deferred::TOOL_ENTER_PLAN_MODE_JSON,
        crate::tools::deferred::TOOL_EXIT_PLAN_MODE_JSON,
        crate::tools::deferred::TOOL_ENTER_WORKTREE_JSON,
        crate::tools::deferred::TOOL_EXIT_WORKTREE_JSON,
        crate::tools::deferred::TOOL_TASK_OUTPUT_JSON,
        crate::tools::deferred::TOOL_TASK_STOP_JSON,
        crate::tools::deferred::TOOL_CRON_CREATE_JSON,
        crate::tools::deferred::TOOL_CRON_DELETE_JSON,
        crate::tools::deferred::TOOL_CRON_LIST_JSON,
        crate::tools::deferred::TOOL_SCHEDULE_WAKEUP_JSON,
        crate::tools::deferred::TOOL_ASK_USER_QUESTION_JSON,
    ];
    raws.iter()
        .map(|raw| {
            serde_json::from_str::<ToolSchema>(raw)
                .expect("bundled deferred tool schema is well-formed JSON")
        })
        .collect()
}

/// Deferred-tool schemas — surfaced only through `ToolSearch`, never on
/// the wire `tools[]` body. 018 first wave: TaskCreate, TaskList,
/// TaskGet, TaskUpdate, NotebookEdit. 019 second wave adds WebFetch +
/// WebSearch.
pub fn deferred_schemas() -> &'static [ToolSchema] {
    static SCHEMAS: OnceLock<Vec<ToolSchema>> = OnceLock::new();
    SCHEMAS.get_or_init(load_deferred).as_slice()
}

/// Combined wire + deferred catalog, wire-first. Only `ToolSearch`
/// should read this surface — callers that feed the outbound body
/// must stay on `tool_schemas()`.
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

/// Look up a schema by tool name — searches the combined catalog so
/// deferred tools resolve too.
pub fn schema_for(name: &str) -> Option<&'static ToolSchema> {
    all_schemas().iter().find(|s| s.name == name)
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
        // Guardrail: if this count ever drifts, the capture-anchored
        // byte-match chain at `tests/harness_artifacts.rs` breaks.
        assert_eq!(tool_schemas().len(), 9);
    }

    #[test]
    fn deferred_schemas_contain_wave_3_set() {
        // 018 seeded 5 (Task* + NotebookEdit), 019 added 2 web tools,
        // wave 3 adds 10 deferred tools + AskUserQuestion. Total = 18.
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
        // 9 wire + 18 deferred (018 + 019 + wave 3 + AskUserQuestion).
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
        // Domain filters are optional, but the properties must exist so
        // the model sees them as valid inputs.
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
