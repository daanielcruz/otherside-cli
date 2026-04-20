//! Per-artifact byte-match conformance: every file under
//! `fingerprint_corpus/harness/` reconstructs the exact slice it was
//! extracted from in
//! `fingerprint_corpus/tools-glob-single/turn1/request.body.json`.
//!
//! This is the chain-of-trust anchor for change 009. If these tests are
//! green, any downstream consumer (translator, provider body builder)
//! that assembles its output from these artifacts is guaranteed to
//! produce a capture-identical payload under capture-identical inputs.

use std::path::PathBuf;

use otherside::harness;
use serde_json::Value;

fn capture_path() -> PathBuf {
    // cargo test CWD = crate root (`otherside-cli/`); reach up one to outer.
    PathBuf::from("../fingerprint_corpus/tools-glob-single/turn1/request.body.json")
}

fn capture_body() -> Value {
    let raw = std::fs::read_to_string(capture_path()).expect("capture body readable");
    serde_json::from_str(&raw).expect("capture body parses as JSON")
}

#[test]
fn system_prompt_matches_capture() {
    let body = capture_body();
    let captured = body["system"][3]["text"]
        .as_str()
        .expect("system[3].text is a string");
    assert_eq!(
        harness::SYSTEM_PROMPT,
        captured,
        "system-prompt.md must be byte-identical to capture system[3].text"
    );
}

#[test]
fn system_preamble_matches_capture() {
    let body = capture_body();
    let captured: Vec<Value> = body["system"]
        .as_array()
        .expect("system is an array")
        .iter()
        .take(3)
        .cloned()
        .collect();
    let assembled = harness::system::build_system_blocks();
    let assembled_preamble: Vec<Value> = assembled.iter().take(3).cloned().collect();
    assert_eq!(assembled_preamble, captured);
}

#[test]
fn reminder_deferred_tools_matches_capture() {
    let body = capture_body();
    let captured = body["messages"][0]["content"][0]["text"]
        .as_str()
        .expect("content[0].text is a string");
    assert_eq!(harness::REMINDER_DEFERRED_TOOLS, captured);
}

#[test]
fn reminder_skills_matches_capture() {
    let body = capture_body();
    let captured = body["messages"][0]["content"][1]["text"]
        .as_str()
        .expect("content[1].text is a string");
    assert_eq!(harness::REMINDER_SKILLS, captured);
}

#[test]
fn reminder_user_context_matches_capture_after_substitution() {
    // Placeholders in the .tmpl file are substituted at render-time.
    // When we re-render with the capture's literal email + date, we
    // must reproduce content[2].text byte-for-byte.
    let body = capture_body();
    let captured = body["messages"][0]["content"][2]["text"]
        .as_str()
        .expect("content[2].text is a string");
    let rendered =
        otherside::harness::reminders::render_user_context("edaanxx@gmail.com", "2026-04-18");
    assert_eq!(rendered, captured);
}

#[test]
fn envelope_matches_capture_defaults() {
    let body = capture_body();
    let bundled = harness::envelope::build_envelope_defaults();
    for key in [
        "metadata",
        "max_tokens",
        "thinking",
        "context_management",
        "output_config",
        "stream",
    ] {
        assert_eq!(
            bundled[key], body[key],
            "envelope field `{key}` diverges from capture"
        );
    }
    // Key order in bundled must match capture's order for these fields.
    let bundled_keys: Vec<&str> = bundled
        .as_object()
        .expect("envelope is an object")
        .keys()
        .map(|k| k.as_str())
        .collect();
    assert_eq!(
        bundled_keys,
        vec![
            "metadata",
            "max_tokens",
            "thinking",
            "context_management",
            "output_config",
            "stream",
        ]
    );
}

#[test]
fn envelope_has_no_request_specific_keys() {
    let bundled = harness::envelope::build_envelope_defaults();
    for forbidden in ["model", "messages", "system", "tools", "tool_choice"] {
        assert!(
            bundled.get(forbidden).is_none(),
            "envelope must not contain request-specific key `{forbidden}`"
        );
    }
}

fn assert_tool_matches(name: &str, bundled_raw: &str) {
    let body = capture_body();
    let captured = body["tools"]
        .as_array()
        .expect("tools is an array")
        .iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("capture has no tool named {name}"))
        .clone();
    let bundled: Value = serde_json::from_str(bundled_raw)
        .unwrap_or_else(|e| panic!("bundled {name}.json parses: {e}"));
    assert_eq!(bundled, captured, "tool `{name}` diverges from capture");
}

#[test]
fn tool_agent_matches_capture() {
    assert_tool_matches("Agent", harness::TOOL_AGENT_JSON);
}

#[test]
fn tool_bash_matches_capture() {
    assert_tool_matches("Bash", harness::TOOL_BASH_JSON);
}

#[test]
fn tool_edit_matches_capture() {
    assert_tool_matches("Edit", harness::TOOL_EDIT_JSON);
}

#[test]
fn tool_glob_matches_capture() {
    assert_tool_matches("Glob", harness::TOOL_GLOB_JSON);
}

#[test]
fn tool_grep_matches_capture() {
    assert_tool_matches("Grep", harness::TOOL_GREP_JSON);
}

#[test]
fn tool_read_matches_capture() {
    assert_tool_matches("Read", harness::TOOL_READ_JSON);
}

#[test]
fn tool_skill_matches_capture() {
    assert_tool_matches("Skill", harness::TOOL_SKILL_JSON);
}

#[test]
fn tool_tool_search_matches_capture() {
    assert_tool_matches("ToolSearch", harness::TOOL_TOOL_SEARCH_JSON);
}

#[test]
fn tool_write_matches_capture() {
    assert_tool_matches("Write", harness::TOOL_WRITE_JSON);
}

#[test]
fn build_tools_array_is_canonical_order() {
    let arr = harness::tools::build_tools_array();
    let names: Vec<&str> = arr
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, harness::TOOL_ORDER.to_vec());
}

#[test]
fn build_tools_array_matches_capture() {
    let body = capture_body();
    let captured: Vec<Value> = body["tools"].as_array().unwrap().clone();
    let bundled = harness::tools::build_tools_array();
    assert_eq!(bundled, captured);
}
