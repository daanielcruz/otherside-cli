

pub mod reminders;
pub mod task_notification;

pub const SYSTEM_BILLING_HEADER: &str =
    include_str!("../../harness_corpus/system/00-billing-header.md");

pub const SYSTEM_AGENT_PREAMBLE: &str =
    include_str!("../../harness_corpus/system/02-agent-preamble.md");

pub const SYSTEM_PROMPT: &str =
    include_str!("../../harness_corpus/system/03-main-prompt.md");

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
