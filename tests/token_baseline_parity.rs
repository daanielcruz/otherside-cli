//! First-turn body parity across Anthropic (ClaudeCode + ThirdParty) and
//! Codex. Guards against silent drops of harness blocks on any provider.
//!
//! User report 2026-04-22: anthropic first turn ~20k tokens, codex/kimi
//! ~11-13k. Delta 7-9k tokens suggests a harness block missing on
//! non-anthropic. Byte accounting here pins the static content reaching
//! each provider so a regression (dropped preamble, dropped main prompt,
//! dropped reminders, missing tool) fails loudly instead of silently
//! shipping a smaller payload.

use otherside::translator::anthropic::UserContext;
use otherside::inference::{OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole};
use otherside::translator::{
    anthropic::{
        build_request_body_with_flavor_and_thinking,
        system::SystemFlavor,
        tools::build_tools_array,
    },
    codex::request::{build_responses_body_with_ctx, openai_tools_to_codex_tools},
};

fn anchor_request() -> OpenAiChatRequest {
    OpenAiChatRequest {
        model: "test-model".into(),
        messages: vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: "say hi".into(),
            name: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
        }],
        ..Default::default()
    }
}

fn anchor_ctx() -> UserContext<'static> {
    UserContext {
        email: "baseline@example.com",
        current_date: "2026-04-22",
        cwd: "/tmp/baseline",
        is_git_repo: true,
        platform: "darwin",
        shell: "zsh",
        os_version: "Darwin 25.3.0",
        memory_dir: "/tmp/baseline/memory/",
        git_status: "Current branch: main\n\nStatus:\n(clean)",
    }
}

/// Pin harness byte counts so any drop is caught in CI. Upstream harness
/// sizes are derived from `harness_corpus/system/` + `system-reminders/`
/// at the time of the first-turn probe. Thresholds lower-bound what MUST
/// reach each provider.
const MIN_PREAMBLE_BYTES: usize = 9_000;
const MIN_MAIN_PROMPT_BYTES: usize = 18_000;
const MIN_REMINDER_BYTES: usize = 1_000;
const MIN_TOOLS_BYTES: usize = 30_000;

#[test]
fn anthropic_claude_code_first_turn_includes_full_harness() {
    let req = anchor_request();
    let ctx = anchor_ctx();
    let body = build_request_body_with_flavor_and_thinking(
        &req,
        &ctx,
        SystemFlavor::ClaudeCode,
        None,
    )
    .expect("anthropic body builds");
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let system_blocks = parsed["system"].as_array().expect("system array");
    // ClaudeCode flavor = billing + opener + preamble + main (4 blocks).
    assert_eq!(system_blocks.len(), 4, "ClaudeCode system has 4 blocks");

    let system_bytes: usize = system_blocks
        .iter()
        .map(|b| b["text"].as_str().map(str::len).unwrap_or(0))
        .sum();
    assert!(
        system_bytes > MIN_PREAMBLE_BYTES + MIN_MAIN_PROMPT_BYTES,
        "anthropic system dropped content: {system_bytes} bytes"
    );

    let tools = parsed["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 9, "9 canonical tools sent");
    let tools_bytes = serde_json::to_string(&parsed["tools"]).unwrap().len();
    assert!(
        tools_bytes > MIN_TOOLS_BYTES,
        "anthropic tools dropped content: {tools_bytes} bytes"
    );
}

#[test]
fn anthropic_third_party_first_turn_includes_full_harness() {
    let req = anchor_request();
    let ctx = anchor_ctx();
    let body = build_request_body_with_flavor_and_thinking(
        &req,
        &ctx,
        SystemFlavor::ThirdParty,
        None,
    )
    .expect("third-party body builds");
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let system_blocks = parsed["system"].as_array().expect("system array");
    // ThirdParty drops billing + opener = 2 blocks (preamble + main only).
    assert_eq!(
        system_blocks.len(),
        2,
        "ThirdParty system has 2 blocks (preamble + main)"
    );

    let system_bytes: usize = system_blocks
        .iter()
        .map(|b| b["text"].as_str().map(str::len).unwrap_or(0))
        .sum();
    assert!(
        system_bytes > MIN_PREAMBLE_BYTES + MIN_MAIN_PROMPT_BYTES,
        "third-party system dropped content: {system_bytes} bytes"
    );

    let tools = parsed["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 9, "9 canonical tools reach third-party");
}

#[test]
fn codex_first_turn_instructions_carry_preamble_plus_main() {
    let req = anchor_request();
    let ctx = anchor_ctx();
    // Translate the anthropic tool Values into codex function-tool shape so
    // we exercise the same path the real Codex provider takes. Tools are
    // passed pre-translated because Codex body builder accepts `Vec<Value>`.
    let anth_tools: Vec<otherside::inference::OpenAiToolDef> = build_tools_array()
        .into_iter()
        .map(|v| {
            // The anthropic array shape is {name, description, input_schema}.
            // Map into OpenAiToolDef for codex translation.
            let name = v["name"].as_str().unwrap_or("").to_string();
            let description = v["description"].as_str().unwrap_or("").to_string();
            let parameters = v["input_schema"].clone();
            otherside::inference::OpenAiToolDef {
                kind: "function".to_string(),
                function: otherside::inference::OpenAiFunctionDef {
                    name,
                    description,
                    parameters,
                },
            }
        })
        .collect();
    let codex_tools = openai_tools_to_codex_tools(&anth_tools);

    let body = build_responses_body_with_ctx(&req, codex_tools, None, Some(&ctx));

    let instructions = body["instructions"]
        .as_str()
        .expect("instructions string");
    assert!(
        instructions.len() > MIN_PREAMBLE_BYTES + MIN_MAIN_PROMPT_BYTES,
        "codex instructions dropped content: {} bytes",
        instructions.len()
    );

    let input = body["input"].as_array().expect("input array");
    let first = input.first().expect("first user message");
    let first_content = first["content"].as_array().expect("first content array");
    assert_eq!(
        first_content.len(),
        4,
        "codex first user = 3 reminders + 1 user text"
    );
    let reminder_bytes: usize = first_content
        .iter()
        .take(3)
        .map(|b| b["text"].as_str().map(str::len).unwrap_or(0))
        .sum();
    assert!(
        reminder_bytes > MIN_REMINDER_BYTES,
        "codex reminders dropped content: {reminder_bytes} bytes"
    );

    let tools = body["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 9, "9 tools reach codex");
}

/// Cross-provider byte baseline — serialize full body per provider and
/// report lengths. Asserts each provider's payload is within ±15% of the
/// others; larger drift means a harness block was dropped.
#[test]
fn harness_body_size_within_fifteen_percent_across_providers() {
    let req = anchor_request();
    let ctx = anchor_ctx();

    let anth_cc = build_request_body_with_flavor_and_thinking(
        &req,
        &ctx,
        SystemFlavor::ClaudeCode,
        None,
    )
    .unwrap();
    let anth_tp = build_request_body_with_flavor_and_thinking(
        &req,
        &ctx,
        SystemFlavor::ThirdParty,
        None,
    )
    .unwrap();

    let anth_tools: Vec<otherside::inference::OpenAiToolDef> = build_tools_array()
        .into_iter()
        .map(|v| {
            let name = v["name"].as_str().unwrap_or("").to_string();
            let description = v["description"].as_str().unwrap_or("").to_string();
            let parameters = v["input_schema"].clone();
            otherside::inference::OpenAiToolDef {
                kind: "function".to_string(),
                function: otherside::inference::OpenAiFunctionDef {
                    name,
                    description,
                    parameters,
                },
            }
        })
        .collect();
    let codex_body = serde_json::to_vec(&build_responses_body_with_ctx(
        &req,
        openai_tools_to_codex_tools(&anth_tools),
        None,
        Some(&ctx),
    ))
    .unwrap();

    let sizes = [
        ("anthropic-oauth", anth_cc.len()),
        ("kimi", anth_tp.len()),
        ("codex", codex_body.len()),
    ];

    let max = sizes.iter().map(|(_, n)| *n).max().unwrap();
    let min = sizes.iter().map(|(_, n)| *n).min().unwrap();
    let drift = (max - min) as f64 / max as f64;

    assert!(
        drift < 0.15,
        "first-turn body drift {:.1}% exceeds 15% tolerance: {:?}",
        drift * 100.0,
        sizes
    );

    // Emit observed sizes so failures + manual runs surface the baseline
    // we're defending against.
    eprintln!(
        "baseline body sizes (bytes): anthropic-oauth={} kimi={} codex={} drift={:.1}%",
        sizes[0].1,
        sizes[1].1,
        sizes[2].1,
        drift * 100.0,
    );
}
