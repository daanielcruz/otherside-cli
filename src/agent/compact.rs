//! Compact conversation prompt + formatter primitives + async runner.
//!
//! Verbatim port of `services/compact/prompt.ts` from upstream 2.1.117. Only
//! the base (full-conversation) path is ported — partial/up-to variants are
//! post-MVP. `compact_conversation` streams a single-turn summary request
//! through the active provider, drops any attempted tool calls, and returns
//! the raw assistant text (caller applies `format_compact_summary`).

use std::pin::Pin;

use futures::StreamExt;

use crate::error::{Error, Result};
use crate::inference::{
    OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole, OpenAiChunk,
};
use crate::provider::{ChunkStream, Provider};
use crate::thinking::ThinkingConfig;

const NO_TOOLS_PREAMBLE: &str = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

";

const DETAILED_ANALYSIS_INSTRUCTION_BASE: &str = "Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.";

fn base_compact_prompt() -> String {
    format!(
        "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

{DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
"
    )
}

const NO_TOOLS_TRAILER: &str = "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";

/// Build the base compact prompt, optionally appending user custom instructions.
pub fn get_compact_prompt(custom_instructions: Option<&str>) -> String {
    let mut prompt = String::with_capacity(16_000);
    prompt.push_str(NO_TOOLS_PREAMBLE);
    prompt.push_str(&base_compact_prompt());

    if let Some(ci) = custom_instructions {
        let trimmed = ci.trim();
        if !trimmed.is_empty() {
            prompt.push_str("\n\nAdditional Instructions:\n");
            prompt.push_str(ci);
        }
    }

    prompt.push_str(NO_TOOLS_TRAILER);
    prompt
}

/// Strip the `<analysis>` drafting scratchpad and swap the `<summary>` XML tags
/// for a readable `Summary:` header. Mirrors upstream `formatCompactSummary`.
pub fn format_compact_summary(summary: &str) -> String {
    let mut out = strip_first_tag(summary, "analysis");

    if let Some((start, end, inner)) = find_tag(&out, "summary") {
        let replacement = format!("Summary:\n{}", inner.trim());
        let mut rebuilt = String::with_capacity(out.len() + replacement.len());
        rebuilt.push_str(&out[..start]);
        rebuilt.push_str(&replacement);
        rebuilt.push_str(&out[end..]);
        out = rebuilt;
    }

    collapse_blank_runs(&out).trim().to_string()
}

/// Compose the synthetic user message seeded post-compact. Mirrors upstream
/// `getCompactUserSummaryMessage`. The `KAIROS`/`PROACTIVE` branch is not
/// ported (those build flags are cut in otherside).
pub fn get_compact_user_summary_message(
    summary: &str,
    suppress_follow_up_questions: bool,
    transcript_path: Option<&str>,
    recent_messages_preserved: bool,
    _is_auto_compact: bool,
) -> String {
    let formatted = format_compact_summary(summary);
    let mut base = format!(
        "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n{formatted}"
    );

    if let Some(path) = transcript_path {
        base.push_str(&format!(
            "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: {path}"
        ));
    }

    if recent_messages_preserved {
        base.push_str("\n\nRecent messages are preserved verbatim.");
    }

    if suppress_follow_up_questions {
        base.push_str("\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened.");
    }

    base
}

fn strip_first_tag(source: &str, tag: &str) -> String {
    match find_tag(source, tag) {
        Some((start, end, _)) => {
            let mut out = String::with_capacity(source.len());
            out.push_str(&source[..start]);
            out.push_str(&source[end..]);
            out
        }
        None => source.to_string(),
    }
}

fn find_tag<'a>(source: &'a str, tag: &str) -> Option<(usize, usize, &'a str)> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = source.find(&open)?;
    let inner_start = start + open.len();
    let close_rel = source[inner_start..].find(&close)?;
    let inner_end = inner_start + close_rel;
    let end = inner_end + close.len();
    Some((start, end, &source[inner_start..inner_end]))
}

fn collapse_blank_runs(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut newline_run = 0usize;
    for ch in source.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push('\n');
            }
        } else {
            newline_run = 0;
            out.push(ch);
        }
    }
    out
}

/// Drive one streaming turn that asks the model to summarize `history`.
///
/// Parallels upstream `streamCompactSummary` → `compactConversation` (minus
/// the PTL retry / cache-sharing fork / hook pipeline). Caller owns wiring the
/// returned summary back into state (either replace history with a single
/// synthetic user message carrying `get_compact_user_summary_message`, or
/// drop the tail entirely for manual `/compact`).
pub async fn compact_conversation(
    provider: &(dyn Provider + Send + Sync),
    model: &str,
    history: Vec<OpenAiChatMessage>,
    custom_instructions: Option<&str>,
    thinking: Option<ThinkingConfig>,
) -> Result<String> {
    if history.is_empty() {
        return Err(Error::Other(
            "compact: refusing to summarize empty history".to_string(),
        ));
    }

    let prompt = get_compact_prompt(custom_instructions);
    let mut messages = history;
    messages.push(OpenAiChatMessage {
        role: OpenAiChatRole::User,
        content: prompt,
        name: None,
        tool_calls: Vec::new(),
        tool_call_id: None,
        reasoning_content: None,
        thinking_signature: None,
    });

    let req = OpenAiChatRequest {
        model: model.to_string(),
        messages,
        stream: Some(true),
        max_tokens: None,
        temperature: None,
        top_p: None,
        stop: None,
        tools: Vec::new(),
        tool_choice: None,
        extra: serde_json::Map::new(),
    };

    let mut stream: Pin<Box<ChunkStream>> = Box::pin(provider.stream(req, thinking).await?);
    let mut summary = String::new();

    while let Some(item) = stream.next().await {
        match item {
            Ok(OpenAiChunk { choices, .. }) => {
                for choice in choices {
                    if let Some(text) = choice.delta.content {
                        summary.push_str(&text);
                    }
                }
            }
            Err(e) => return Err(e),
        }
    }

    if summary.trim().is_empty() {
        return Err(Error::Other(
            "compact: provider returned empty summary".to_string(),
        ));
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_prompt_starts_with_no_tools_preamble() {
        let p = get_compact_prompt(None);
        assert!(
            p.starts_with("CRITICAL: Respond with TEXT ONLY."),
            "prompt must lead with upstream NO_TOOLS_PREAMBLE so tool-call refusals aren't buried"
        );
    }

    #[test]
    fn compact_prompt_ends_with_no_tools_trailer() {
        let p = get_compact_prompt(None);
        assert!(
            p.ends_with("Tool calls will be rejected and you will fail the task."),
            "trailer must land at end — upstream uses it as last-line reinforcement"
        );
    }

    #[test]
    fn compact_prompt_embeds_nine_section_spec() {
        let p = get_compact_prompt(None);
        for header in [
            "1. Primary Request and Intent",
            "2. Key Technical Concepts",
            "3. Files and Code Sections",
            "4. Errors and fixes",
            "5. Problem Solving",
            "6. All user messages",
            "7. Pending Tasks",
            "8. Current Work",
            "9. Optional Next Step",
        ] {
            assert!(p.contains(header), "missing upstream section header: {header}");
        }
    }

    #[test]
    fn compact_prompt_appends_custom_instructions_when_provided() {
        let p = get_compact_prompt(Some("focus on rust unsafe blocks"));
        assert!(p.contains("Additional Instructions:\nfocus on rust unsafe blocks"));
    }

    #[test]
    fn compact_prompt_skips_empty_or_whitespace_instructions() {
        let empty = get_compact_prompt(Some(""));
        let ws = get_compact_prompt(Some("   \n\t "));
        assert!(!empty.contains("Additional Instructions:"));
        assert!(!ws.contains("Additional Instructions:"));
    }

    #[test]
    fn format_strips_analysis_block() {
        let raw = "<analysis>drafting scratch</analysis>\n\n<summary>final result</summary>";
        let out = format_compact_summary(raw);
        assert!(!out.contains("<analysis>"));
        assert!(!out.contains("drafting scratch"));
    }

    #[test]
    fn format_replaces_summary_tags_with_header() {
        let raw = "<analysis>x</analysis>\n<summary>1. Intent: port compact</summary>";
        let out = format_compact_summary(raw);
        assert!(out.starts_with("Summary:\n"));
        assert!(out.contains("1. Intent: port compact"));
        assert!(!out.contains("<summary>"));
    }

    #[test]
    fn format_collapses_blank_runs() {
        let raw = "<summary>a\n\n\n\nb</summary>";
        let out = format_compact_summary(raw);
        assert!(!out.contains("\n\n\n"), "triple+ newlines leak: {out:?}");
    }

    #[test]
    fn format_is_noop_when_no_tags_present() {
        let raw = "plain text with no xml";
        assert_eq!(format_compact_summary(raw), "plain text with no xml");
    }

    #[test]
    fn user_summary_includes_continuation_framing() {
        let msg = get_compact_user_summary_message(
            "<summary>port work</summary>",
            false,
            None,
            false,
            false,
        );
        assert!(msg.starts_with("This session is being continued"));
        assert!(msg.contains("Summary:\nport work"));
    }

    #[test]
    fn user_summary_appends_transcript_pointer_when_given() {
        let msg = get_compact_user_summary_message(
            "<summary>s</summary>",
            false,
            Some("/tmp/t.jsonl"),
            false,
            false,
        );
        assert!(msg.contains("read the full transcript at: /tmp/t.jsonl"));
    }

    #[test]
    fn user_summary_flags_preserved_tail_when_set() {
        let msg = get_compact_user_summary_message(
            "<summary>s</summary>",
            false,
            None,
            true,
            false,
        );
        assert!(msg.contains("Recent messages are preserved verbatim."));
    }

    #[test]
    fn user_summary_suppresses_follow_up_when_requested() {
        let msg = get_compact_user_summary_message(
            "<summary>s</summary>",
            true,
            None,
            false,
            true,
        );
        assert!(msg.contains("Continue the conversation from where it left off"));
        assert!(msg.contains("do not acknowledge the summary"));
    }

    use std::pin::Pin as StdPin;
    use std::sync::Arc;

    use crate::inference::{OpenAiChoice, OpenAiDelta};

    struct ScriptedProvider {
        chunks: Vec<OpenAiChunk>,
    }

    impl Provider for ScriptedProvider {
        fn id(&self) -> &'static str {
            "scripted"
        }

        fn stream<'a>(
            &'a self,
            _req: OpenAiChatRequest,
            _thinking: Option<ThinkingConfig>,
        ) -> StdPin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>>
        {
            let chunks = self.chunks.clone();
            Box::pin(async move {
                let stream = futures::stream::iter(chunks.into_iter().map(Ok));
                let boxed: ChunkStream = Box::pin(stream);
                Ok(boxed)
            })
        }
    }

    fn text_chunk(delta: &str) -> OpenAiChunk {
        OpenAiChunk {
            id: "x".into(),
            object: OpenAiChunk::OBJECT.to_string(),
            created: 0,
            model: "m".into(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    role: None,
                    content: Some(delta.into()),
                    tool_calls: Vec::new(),
                    ..Default::default()
                },
                finish_reason: None,
            }],
            usage: None,
        }
    }

    fn history_one() -> Vec<OpenAiChatMessage> {
        vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: "first turn".into(),
            name: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
            thinking_signature: None,
        }]
    }

    #[tokio::test]
    async fn compact_conversation_concatenates_content_deltas() {
        let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
            chunks: vec![
                text_chunk("<analysis>"),
                text_chunk("thinking</analysis>\n<summary>done</summary>"),
            ],
        });
        let out = compact_conversation(&*provider, "m", history_one(), None, None)
            .await
            .unwrap();
        assert!(out.contains("<analysis>"));
        assert!(out.ends_with("</summary>"));
    }

    #[tokio::test]
    async fn compact_conversation_rejects_empty_history() {
        let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider { chunks: vec![] });
        let err = compact_conversation(&*provider, "m", Vec::new(), None, None)
            .await
            .unwrap_err();
        match err {
            Error::Other(msg) => assert!(msg.contains("empty history")),
            other => panic!("wrong error: {other}"),
        }
    }

    #[tokio::test]
    async fn compact_conversation_errors_on_empty_summary() {
        let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider { chunks: vec![] });
        let err = compact_conversation(&*provider, "m", history_one(), None, None)
            .await
            .unwrap_err();
        match err {
            Error::Other(msg) => assert!(msg.contains("empty summary")),
            other => panic!("wrong error: {other}"),
        }
    }
}
