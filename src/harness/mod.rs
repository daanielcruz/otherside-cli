

pub mod reminders;
pub mod session_env;
pub mod task_notification;

pub const SYSTEM_BILLING_HEADER: &str =
    include_str!("../../harness_corpus/system/00-billing-header.md");

pub const SYSTEM_OPENER: &str =
    include_str!("../../harness_corpus/system/01-opener.md");

pub const SYSTEM_AGENT_PREAMBLE: &str =
    include_str!("../../harness_corpus/system/02-agent-preamble.md");

pub const SYSTEM_PROMPT: &str =
    include_str!("../../harness_corpus/system/03-main-prompt.md");

pub fn resolved_system_prompt(settings: &crate::config::settings::Settings) -> String {
    let enabled = settings.agent_verification_enabled.unwrap_or(true);
    if enabled {
        return SYSTEM_PROMPT.to_string();
    }
    strip_verification_sections(SYSTEM_PROMPT)
}

fn strip_verification_sections(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut lines = src.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("## Verification") {
            for follow in lines.by_ref() {
                let t = follow.trim_start();
                if t.starts_with("## ") {
                    out.push_str(follow);
                    out.push('\n');
                    break;
                }
            }
            continue;
        }
        if line.contains("spawn the Agent tool with subagent_type=\"verification\"")
            || line.contains("independent adversarial verification must happen before you report completion")
        {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !src.ends_with('\n') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod verification_gate_tests {
    use super::*;
    use crate::config::settings::Settings;

    #[test]
    fn enabled_returns_full_prompt_verbatim() {
        let mut s = Settings::default();
        s.agent_verification_enabled = Some(true);
        assert_eq!(resolved_system_prompt(&s), SYSTEM_PROMPT);
    }

    #[test]
    fn default_setting_keeps_verification_block_visible() {
        let s = Settings::default();
        let out = resolved_system_prompt(&s);
        assert!(
            out.contains("## Verification"),
            "default (None) must keep verification section — was: {}",
            out.len()
        );
    }

    #[test]
    fn disabled_strips_verification_header_and_body() {
        let mut s = Settings::default();
        s.agent_verification_enabled = Some(false);
        let out = resolved_system_prompt(&s);
        assert!(
            !out.contains("## Verification"),
            "disabled prompt still contains `## Verification`"
        );
        assert!(
            !out.contains("subagent_type=\"verification\""),
            "disabled prompt still mentions verification subagent_type"
        );
    }

    #[test]
    fn disabled_preserves_other_sections() {
        let mut s = Settings::default();
        s.agent_verification_enabled = Some(false);
        let out = resolved_system_prompt(&s);
        assert!(out.contains("## Persistence over premature closure"));
        assert!(out.contains("## Code comments"));
        assert!(out.contains("## Truthfulness"));
    }
}

pub const REMINDER_DEFERRED_TOOLS: &str =
    include_str!("../../harness_corpus/system-reminders/deferred-tools.md");

pub const REMINDER_SKILLS: &str =
    include_str!("../../harness_corpus/system-reminders/skills.md");

pub const REMINDER_USER_CONTEXT_TMPL: &str =
    include_str!("../../harness_corpus/system-reminders/user-context.tmpl.md");

pub const TOOL_AGENT_JSON: &str =
    include_str!("../../harness_corpus/tools/Agent.json");

pub const TOOL_BASH_JSON: &str =
    include_str!("../../harness_corpus/tools/Bash.json");

pub const TOOL_EDIT_JSON: &str =
    include_str!("../../harness_corpus/tools/Edit.json");

pub const TOOL_GLOB_JSON: &str =
    include_str!("../../harness_corpus/tools/Glob.json");

pub const TOOL_GREP_JSON: &str =
    include_str!("../../harness_corpus/tools/Grep.json");

pub const TOOL_READ_JSON: &str =
    include_str!("../../harness_corpus/tools/Read.json");

pub const TOOL_SKILL_JSON: &str =
    include_str!("../../harness_corpus/tools/Skill.json");

pub const TOOL_TOOL_SEARCH_JSON: &str =
    include_str!("../../harness_corpus/tools/ToolSearch.json");

pub const TOOL_WRITE_JSON: &str =
    include_str!("../../harness_corpus/tools/Write.json");

pub const TOOL_TASK_CREATE_JSON: &str =
    include_str!("../../harness_corpus/tools/TaskCreate.json");

pub const TOOL_TASK_LIST_JSON: &str =
    include_str!("../../harness_corpus/tools/TaskList.json");

pub const TOOL_TASK_GET_JSON: &str =
    include_str!("../../harness_corpus/tools/TaskGet.json");

pub const TOOL_TASK_UPDATE_JSON: &str =
    include_str!("../../harness_corpus/tools/TaskUpdate.json");

pub const TOOL_TASK_OUTPUT_JSON: &str =
    include_str!("../../harness_corpus/tools/TaskOutput.json");

pub const TOOL_TASK_STOP_JSON: &str =
    include_str!("../../harness_corpus/tools/TaskStop.json");

pub const TOOL_NOTEBOOK_EDIT_JSON: &str =
    include_str!("../../harness_corpus/tools/NotebookEdit.json");

pub const TOOL_WEB_FETCH_JSON: &str =
    include_str!("../../harness_corpus/tools/WebFetch.json");

pub const TOOL_WEB_SEARCH_JSON: &str =
    include_str!("../../harness_corpus/tools/WebSearch.json");

pub const TOOL_ENTER_PLAN_MODE_JSON: &str =
    include_str!("../../harness_corpus/tools/EnterPlanMode.json");

pub const TOOL_EXIT_PLAN_MODE_JSON: &str =
    include_str!("../../harness_corpus/tools/ExitPlanMode.json");

pub const TOOL_ENTER_WORKTREE_JSON: &str =
    include_str!("../../harness_corpus/tools/EnterWorktree.json");

pub const TOOL_EXIT_WORKTREE_JSON: &str =
    include_str!("../../harness_corpus/tools/ExitWorktree.json");

pub const TOOL_CRON_CREATE_JSON: &str =
    include_str!("../../harness_corpus/tools/CronCreate.json");

pub const TOOL_CRON_DELETE_JSON: &str =
    include_str!("../../harness_corpus/tools/CronDelete.json");

pub const TOOL_CRON_LIST_JSON: &str =
    include_str!("../../harness_corpus/tools/CronList.json");

pub const TOOL_SCHEDULE_WAKEUP_JSON: &str =
    include_str!("../../harness_corpus/tools/ScheduleWakeup.json");

pub const TOOL_ASK_USER_QUESTION_JSON: &str =
    include_str!("../../harness_corpus/tools/AskUserQuestion.json");

pub const TOOL_SEND_MESSAGE_JSON: &str =
    include_str!("../../harness_corpus/tools/SendMessage.json");

pub const ENVELOPE_JSON: &str =
    include_str!("../../harness_corpus/envelope.json");

pub const TOOL_ORDER: [&str; 9] = [
    "Agent",
    "Bash",
    "Edit",
    "Glob",
    "Grep",
    "Read",
    "Skill",
    "ToolSearch",
    "Write",
];
