

use otherside::subagents::{install_runner, InlineFakeRunner, SubagentRunner};
use otherside::tools::{dispatch, ToolError};
use serde_json::json;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

static FAKE: OnceLock<Arc<InlineFakeRunner>> = OnceLock::new();

static TEST_LOCK: Mutex<()> = Mutex::new(());

fn ensure_runner() -> (Arc<InlineFakeRunner>, MutexGuard<'static, ()>) {
    let fake = FAKE
        .get_or_init(|| {
            let f = Arc::new(InlineFakeRunner::new());
            let _ = install_runner(f.clone() as Arc<dyn SubagentRunner>);
            f
        })
        .clone();

    let guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    fake.set_content("");
    fake.set_tool_uses(0);
    fake.set_tokens(0);
    fake.set_duration(0);
    (fake, guard)
}

#[test]
fn agent_happy_path_returns_completed_shape() {
    let (fake, _guard) = ensure_runner();
    fake.set_content("ok");
    fake.set_tool_uses(3);
    fake.set_tokens(250);
    fake.set_duration(1800);

    let res = dispatch(
        "Agent",
        &json!({
            "description": "Trivial echo",
            "prompt": "Return the string 'ok'",
            "subagent_type": "general-purpose",
        }),
    )
    .expect("Agent dispatch must succeed");

    assert_eq!(res["status"], "completed");
    assert_eq!(res["subagent_type"], "general-purpose");
    assert_eq!(res["totalToolUseCount"], 3);
    assert_eq!(res["totalTokens"], 250);
    assert_eq!(res["totalDurationMs"], 1800);

    let content = res["content"].as_array().expect("content array");
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[0]["text"], "ok");
}

#[test]
fn agent_unknown_subagent_type_returns_invalid_args() {
    let _g = ensure_runner();
    let res = dispatch(
        "Agent",
        &json!({
            "description": "x",
            "prompt": "y",
            "subagent_type": "does-not-exist-020",
        }),
    );
    let err = res.expect_err("unknown type must error");

    let err_str = err.to_string();
    assert!(
        err_str.contains("unknown subagent_type"),
        "message: {err_str}"
    );
    assert!(
        err_str.contains("does-not-exist-020"),
        "message should quote the offending name: {err_str}"
    );
    assert!(
        err_str.contains("general-purpose"),
        "message should list registered types: {err_str}"
    );
}

#[test]
fn agent_defaults_subagent_type_to_general_purpose() {
    let (fake, _guard) = ensure_runner();
    fake.set_content("default");
    let res = dispatch(
        "Agent",
        &json!({
            "description": "No subagent_type",
            "prompt": "probe",
        }),
    )
    .unwrap();
    if res["status"] == "completed" {
        assert_eq!(res["subagent_type"], "general-purpose");
    } else {

        assert_eq!(res["status"], "unavailable");
    }
}

#[test]
fn agent_reader_subagent_resolves() {
    let (fake, _guard) = ensure_runner();
    fake.set_content("reader-ok");
    let res = dispatch(
        "Agent",
        &json!({
            "description": "Read-only probe",
            "prompt": "find main.rs",
            "subagent_type": "reader",
        }),
    )
    .unwrap();
    if res["status"] == "completed" {
        assert_eq!(res["subagent_type"], "reader");
    }
}

#[test]
fn agent_requires_description_and_prompt() {
    let _g = ensure_runner();
    let err = dispatch("Agent", &json!({})).unwrap_err();
    match err {
        ToolError::InvalidArgs(_) => {}
        _ => panic!("expected InvalidArgs for empty args, got {err:?}"),
    }
    let err = dispatch("Agent", &json!({"description": "x"})).unwrap_err();
    match err {
        ToolError::InvalidArgs(_) => {}
        _ => panic!("expected InvalidArgs when prompt missing"),
    }
}
