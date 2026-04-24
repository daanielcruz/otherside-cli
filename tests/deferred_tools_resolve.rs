

use otherside::tools::{self, schemas};
use serde_json::{json, Value};

fn write_fixture_ipynb(path: &std::path::Path, cell_id: &str, source: &str) {
    let ipynb = json!({
        "cells": [{
            "cell_type": "code",
            "id": cell_id,
            "source": source,
            "metadata": {},
            "execution_count": 7,
            "outputs": [{"output_type": "stream", "text": "stale"}]
        }],
        "metadata": { "language_info": { "name": "python" } },
        "nbformat": 4,
        "nbformat_minor": 5
    });
    std::fs::write(path, serde_json::to_string_pretty(&ipynb).unwrap()).unwrap();
}

fn scratch_path(stem: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let dir = base.join(format!("otherside-018-{pid}-{ts}-{stem}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn task_lifecycle_end_to_end_through_dispatcher() {

    let search = tools::dispatch(
        "ToolSearch",
        &json!({"query": "select:TaskCreate", "max_results": 5}),
    )
    .unwrap();
    let search_tools = search["tools"].as_array().unwrap();
    assert_eq!(search_tools.len(), 1);
    assert_eq!(search_tools[0]["name"], "TaskCreate");

    let created = tools::dispatch(
        "TaskCreate",
        &json!({"subject": "integration test 018", "description": "e2e flow"}),
    )
    .unwrap();
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    assert!(!task_id.is_empty());

    let listed = tools::dispatch("TaskList", &json!({})).unwrap();
    let listed_tasks = listed["tasks"].as_array().unwrap();
    assert!(
        listed_tasks
            .iter()
            .any(|t| t["id"].as_str() == Some(task_id.as_str())),
        "TaskList must include the just-created task"
    );

    let updated = tools::dispatch(
        "TaskUpdate",
        &json!({"taskId": task_id, "status": "completed"}),
    )
    .unwrap();
    assert_eq!(updated["success"], true);
    let fields = updated["updatedFields"].as_array().unwrap();
    assert!(fields.iter().any(|v| v == "status"));
    assert_eq!(updated["statusChange"]["to"], "completed");

    let got = tools::dispatch("TaskGet", &json!({"taskId": task_id})).unwrap();
    assert_eq!(got["task"]["status"], "completed");
}

#[test]
fn notebook_edit_round_trip_through_dispatcher() {
    let dir = scratch_path("nb");
    let nb_path = dir.join("fixture.ipynb");
    write_fixture_ipynb(&nb_path, "cell-42", "print(1)");

    let search = tools::dispatch(
        "ToolSearch",
        &json!({"query": "select:NotebookEdit", "max_results": 5}),
    )
    .unwrap();
    assert_eq!(search["tools"][0]["name"], "NotebookEdit");

    let out = tools::dispatch(
        "NotebookEdit",
        &json!({
            "notebook_path": nb_path.to_str().unwrap(),
            "cell_id": "cell-42",
            "new_source": "print(42)",
        }),
    )
    .expect("NotebookEdit dispatch must succeed for a valid fixture");
    assert_eq!(out["edit_mode"], "replace");
    assert_eq!(out["cell_id"], "cell-42");
    assert_eq!(out["new_source"], "print(42)");

    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&nb_path).unwrap()).unwrap();
    assert_eq!(written["cells"][0]["source"], "print(42)");
    assert!(written["cells"][0]["execution_count"].is_null());
    assert_eq!(written["cells"][0]["outputs"], json!([]));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn wire_catalog_stays_at_nine_after_deferred_dispatch() {

    assert_eq!(schemas::tool_schemas().len(), 9);
    let names: Vec<&str> = schemas::tool_schemas()
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"]
    );

    let deferred: Vec<&str> = schemas::deferred_schemas()
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(
        deferred,
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

    assert_eq!(schemas::all_schemas().len(), 28);
}

#[test]
fn tool_search_substring_query_covers_deferred_tools() {
    let out =
        tools::dispatch("ToolSearch", &json!({"query": "notebook", "max_results": 10})).unwrap();
    let tools_arr = out["tools"].as_array().unwrap();
    assert!(
        tools_arr
            .iter()
            .any(|t| t["name"] == "NotebookEdit"),
        "substring `notebook` must surface the deferred NotebookEdit tool"
    );
}

#[test]
fn dispatch_unknown_deferred_name_still_errors() {

    let err = tools::dispatch("AskUserQuestion", &json!({})).unwrap_err();
    assert!(matches!(
        err,
        otherside::tools::ToolError::Unsupported(_)
    ));
    let err = tools::dispatch("SomeFutureToolThatDoesNotExistYet", &json!({})).unwrap_err();
    assert!(matches!(
        err,
        otherside::tools::ToolError::Unsupported(_)
    ));
}

#[test]
fn web_fetch_schema_resolves_through_tool_search() {

    let search = tools::dispatch(
        "ToolSearch",
        &json!({"query": "select:WebFetch", "max_results": 5}),
    )
    .unwrap();
    let search_tools = search["tools"].as_array().unwrap();
    assert_eq!(search_tools.len(), 1);
    assert_eq!(search_tools[0]["name"], "WebFetch");
    let required = search_tools[0]["input_schema"]["required"]
        .as_array()
        .unwrap();
    assert!(required.iter().any(|v| v == "url"));
    assert!(required.iter().any(|v| v == "prompt"));
}

#[test]
fn web_fetch_dispatch_rejects_missing_url() {

    let err = tools::dispatch("WebFetch", &json!({})).unwrap_err();
    assert!(matches!(
        err,
        otherside::tools::ToolError::InvalidArgs(_)
    ));
}

#[test]
fn web_search_schema_resolves_through_tool_search() {

    let search = tools::dispatch(
        "ToolSearch",
        &json!({"query": "select:WebSearch", "max_results": 5}),
    )
    .unwrap();
    let search_tools = search["tools"].as_array().unwrap();
    assert_eq!(search_tools.len(), 1);
    assert_eq!(search_tools[0]["name"], "WebSearch");
    let required = search_tools[0]["input_schema"]["required"]
        .as_array()
        .unwrap();
    assert!(required.iter().any(|v| v == "query"));
}

#[test]
fn web_search_dispatch_rejects_missing_query() {

    let err = tools::dispatch("WebSearch", &json!({})).unwrap_err();
    assert!(matches!(
        err,
        otherside::tools::ToolError::InvalidArgs(_)
    ));
}

#[test]
fn web_search_returns_unavailable_stub_by_default() {

    let saved = std::env::var_os("OTHERSIDE_CONFIG_DIR");
    let tmp = std::env::temp_dir().join(format!(
        "otherside-itest-web-search-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("mkdir temp config dir");
    std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp);

    let out = tools::dispatch("WebSearch", &json!({"query": "rust async"})).unwrap();

    match saved {
        Some(v) => std::env::set_var("OTHERSIDE_CONFIG_DIR", v),
        None => std::env::remove_var("OTHERSIDE_CONFIG_DIR"),
    }
    let _ = std::fs::remove_dir_all(&tmp);

    assert_eq!(out["query"], "rust async");
    let results = out["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    let marker = results[0].as_str().unwrap();
    assert!(marker.starts_with("web_search_unavailable"));
    assert!(marker.contains("anthropic-oauth"));
    assert!(out["durationSeconds"].is_number());
}
