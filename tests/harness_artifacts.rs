

use std::path::PathBuf;

use otherside::{harness, translator};
use serde_json::Value;

fn capture_path() -> PathBuf {

    PathBuf::from("../fingerprint_corpus/tools-glob-single/turn1/request.body.json")
}

fn capture_body() -> Value {
    let raw = std::fs::read_to_string(capture_path()).expect("capture body readable");
    serde_json::from_str(&raw).expect("capture body parses as JSON")
}

#[test]
fn system_prompt_keeps_core_anchors_and_verification_bullet() {

    assert!(
        harness::SYSTEM_PROMPT.contains("subagent_type=\"verification\""),
        "system-prompt.md must include the verification-contract bullet"
    );
    for anchor in [
        "# Output efficiency",
        "# Session-specific guidance",
        "# auto memory",
        "# Environment",
    ] {
        assert!(
            harness::SYSTEM_PROMPT.contains(anchor),
            "system-prompt.md lost section `{anchor}`"
        );
    }
    for placeholder in [
        "_WORKSPACE_DIR_",
        "_IS_GIT_REPO_",
        "_PLATFORM_",
        "_SHELL_",
        "_OS_VERSION_",
        "_MEMORY_DIR_",
    ] {
        assert!(
            harness::SYSTEM_PROMPT.contains(placeholder),
            "system-prompt.md lost env placeholder `{placeholder}`"
        );
    }
}

#[test]
#[ignore = "fingerprint_corpus/tools-glob-single was captured at 2.1.113.3e2; assembly now emits 2.1.117.3c3. Re-capture tools-glob-single scenario at 2.1.117 to re-enable."]
fn system_preamble_block0_matches_capture() {

    let body = capture_body();
    let captured = body["system"][0].clone();
    let assembled = translator::anthropic::system::build_system_blocks();
    assert_eq!(assembled[0], captured);
}

#[test]
fn system_preamble_block1_is_compat_identity_literal() {

    let assembled = translator::anthropic::system::build_system_blocks();
    let text = assembled[1]["text"].as_str().unwrap();
    assert_eq!(
        text,
        "You are Claude Code, Anthropic's official CLI for Claude."
    );
}

#[test]
fn system_preamble_block2_keeps_cache_and_core_guidance() {

    let assembled = translator::anthropic::system::build_system_blocks();
    let block2 = &assembled[2];
    assert_eq!(block2["cache_control"]["type"], "ephemeral");
    assert_eq!(block2["cache_control"]["ttl"], "1h");
    let text = block2["text"].as_str().unwrap();
    for anchor in [
        "You are an interactive agent",
        "IMPORTANT:",
        "# System",
        "# Doing tasks",
        "# Using your tools",
    ] {
        assert!(
            text.contains(anchor),
            "block 2 lost anchor `{anchor}` — V2 edit over-trimmed"
        );
    }
}

#[test]
fn reminder_deferred_tools_is_capture_minus_gdrive() {

    let body = capture_body();
    let captured = body["messages"][0]["content"][0]["text"]
        .as_str()
        .expect("content[0].text is a string");
    for kept in &[
        "AskUserQuestion",
        "TaskCreate",
        "TaskList",
        "WebFetch",
        "WebSearch",
    ] {
        assert!(
            harness::REMINDER_DEFERRED_TOOLS.contains(kept),
            "deferred-tools reminder lost the `{kept}` entry"
        );
        assert!(captured.contains(kept), "capture sanity: lost `{kept}`");
    }
    for removed in &[
        "mcp__claude_ai_Google_Drive__authenticate",
        "mcp__claude_ai_Google_Drive__complete_authentication",
    ] {
        assert!(
            !harness::REMINDER_DEFERRED_TOOLS.contains(removed),
            "deferred-tools reminder must NOT advertise removed `{removed}`"
        );
    }
}

#[test]
fn reminder_skills_is_capture_minus_removed() {

    let body = capture_body();
    let captured = body["messages"][0]["content"][1]["text"]
        .as_str()
        .expect("content[1].text is a string");
    for kept in &["loop:", "init:", "review:", "security-review:"] {
        assert!(
            harness::REMINDER_SKILLS.contains(kept),
            "skills reminder lost the `{kept}` entry"
        );
        assert!(captured.contains(kept), "capture sanity: lost `{kept}`");
    }
    for removed in &[
        "update-config:",
        "keybindings-help:",
        "simplify:",
        "fewer-permission-prompts:",
        "claude-api:",
    ] {
        assert!(
            !harness::REMINDER_SKILLS.contains(removed),
            "skills reminder must NOT advertise removed `{removed}`"
        );
    }
}

#[test]
fn reminder_user_context_matches_capture_after_substitution() {

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
    let bundled = translator::anthropic::envelope::build_envelope_defaults();
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
    let bundled = translator::anthropic::envelope::build_envelope_defaults();
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
    let arr = translator::anthropic::tools::build_tools_array();
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
    let bundled = translator::anthropic::tools::build_tools_array();
    assert_eq!(bundled, captured);
}
