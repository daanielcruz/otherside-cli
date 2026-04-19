//! Integration test — 018 deferred-tools first wave end-to-end.
//!
//! Exercises the full flow the model actually sees:
//!
//! 1. `ToolSearch({"query": "select:TaskCreate"})` → schema resolves
//! 2. `TaskCreate({...})` → task registered, id returned
//! 3. `TaskList({})` → registered entry surfaces
//! 4. `TaskUpdate({status: completed})` → transition reported
//! 5. `TaskGet({taskId})` → final state reflects the update
//! 6. `NotebookEdit` against a tmp `.ipynb` fixture → source replaced
//! 7. Wire catalog stays at exactly 9 entries — deferred surface does
//!    NOT bleed into outbound `tools[]`.

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
    // Step 1 — ToolSearch resolves the schema.
    let search = tools::dispatch(
        "ToolSearch",
        &json!({"query": "select:TaskCreate", "max_results": 5}),
    )
    .unwrap();
    let search_tools = search["tools"].as_array().unwrap();
    assert_eq!(search_tools.len(), 1);
    assert_eq!(search_tools[0]["name"], "TaskCreate");

    // Step 2 — create a task.
    let created = tools::dispatch(
        "TaskCreate",
        &json!({"subject": "integration test 018", "description": "e2e flow"}),
    )
    .unwrap();
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    assert!(!task_id.is_empty());

    // Step 3 — it shows up in the list.
    let listed = tools::dispatch("TaskList", &json!({})).unwrap();
    let listed_tasks = listed["tasks"].as_array().unwrap();
    assert!(
        listed_tasks
            .iter()
            .any(|t| t["id"].as_str() == Some(task_id.as_str())),
        "TaskList must include the just-created task"
    );

    // Step 4 — mark it completed.
    let updated = tools::dispatch(
        "TaskUpdate",
        &json!({"taskId": task_id, "status": "completed"}),
    )
    .unwrap();
    assert_eq!(updated["success"], true);
    let fields = updated["updatedFields"].as_array().unwrap();
    assert!(fields.iter().any(|v| v == "status"));
    assert_eq!(updated["statusChange"]["to"], "completed");

    // Step 5 — confirm via TaskGet.
    let got = tools::dispatch("TaskGet", &json!({"taskId": task_id})).unwrap();
    assert_eq!(got["task"]["status"], "completed");
}

#[test]
fn notebook_edit_round_trip_through_dispatcher() {
    let dir = scratch_path("nb");
    let nb_path = dir.join("fixture.ipynb");
    write_fixture_ipynb(&nb_path, "cell-42", "print(1)");

    // Resolve schema first — mirrors the model's on-demand load.
    let search = tools::dispatch(
        "ToolSearch",
        &json!({"query": "select:NotebookEdit", "max_results": 5}),
    )
    .unwrap();
    assert_eq!(search["tools"][0]["name"], "NotebookEdit");

    // Dispatch the edit.
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

    // Read back and assert mutations landed on disk.
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&nb_path).unwrap()).unwrap();
    assert_eq!(written["cells"][0]["source"], "print(42)");
    assert!(written["cells"][0]["execution_count"].is_null());
    assert_eq!(written["cells"][0]["outputs"], json!([]));

    // Cleanup — ignore errors, the OS sweeps /tmp anyway.
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn wire_catalog_stays_at_nine_after_deferred_dispatch() {
    // 009 + 010 byte-match chain depends on this invariant. Regardless
    // of what the deferred surface exposes, the advertised wire tools
    // MUST stay at exactly nine entries in canonical order.
    assert_eq!(schemas::tool_schemas().len(), 9);
    let names: Vec<&str> = schemas::tool_schemas()
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"]
    );

    // Deferred catalog = 018 first wave + 019 WebFetch + WebSearch.
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
        ]
    );

    // Combined catalog equals wire + deferred in that order.
    assert_eq!(schemas::all_schemas().len(), 16);
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
    // Sanity guardrail: only wired deferred tools route. A name that
    // hasn't been implemented yet (e.g. `EnterWorktree`) still hits the
    // default Unsupported arm.
    let err = tools::dispatch("EnterWorktree", &json!({})).unwrap_err();
    assert!(matches!(
        err,
        otherside::tools::ToolError::Unsupported(_)
    ));
}

#[test]
fn web_fetch_schema_resolves_through_tool_search() {
    // 019 deferred tool — schema must be loadable via ToolSearch so the
    // model can validate inputs before calling WebFetch.
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
    // Per-tool validation: missing `url` returns InvalidArgs (NOT
    // Unsupported) — proves the arm routes to `web_fetch::web_fetch`.
    let err = tools::dispatch("WebFetch", &json!({})).unwrap_err();
    assert!(matches!(
        err,
        otherside::tools::ToolError::InvalidArgs(_)
    ));
}

#[test]
fn web_search_schema_resolves_through_tool_search() {
    // 019 WebSearch deferred tool — schema must be loadable via
    // ToolSearch so the model can validate inputs before calling.
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
    // Per-tool validation: missing `query` returns InvalidArgs (NOT
    // Unsupported) — proves the arm routes to `web_search::web_search`.
    let err = tools::dispatch("WebSearch", &json!({})).unwrap_err();
    assert!(matches!(
        err,
        otherside::tools::ToolError::InvalidArgs(_)
    ));
}

#[test]
fn web_search_returns_unavailable_stub_by_default() {
    // Without OTHERSIDE_GOOGLE_CSE_KEY + _CX set, the dispatcher should
    // return a structured stub. We can't fully control env from an
    // integration test (cargo test inherits process env), so only assert
    // shape invariants that hold in both paths: results is an array,
    // durationSeconds is a number, query echoes.
    //
    // Save-and-clear the env for the duration of the call so the test is
    // deterministic even on developer machines with real keys exported.
    let saved_k = std::env::var("OTHERSIDE_GOOGLE_CSE_KEY").ok();
    let saved_c = std::env::var("OTHERSIDE_GOOGLE_CSE_CX").ok();
    std::env::remove_var("OTHERSIDE_GOOGLE_CSE_KEY");
    std::env::remove_var("OTHERSIDE_GOOGLE_CSE_CX");

    let out = tools::dispatch("WebSearch", &json!({"query": "rust async"})).unwrap();

    // Restore before any assertion so a failure doesn't leak cleared env.
    if let Some(v) = saved_k {
        std::env::set_var("OTHERSIDE_GOOGLE_CSE_KEY", v);
    }
    if let Some(v) = saved_c {
        std::env::set_var("OTHERSIDE_GOOGLE_CSE_CX", v);
    }

    assert_eq!(out["query"], "rust async");
    let results = out["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    let marker = results[0].as_str().unwrap();
    assert!(marker.starts_with("web_search_unavailable"));
    assert!(out["durationSeconds"].is_number());
}
