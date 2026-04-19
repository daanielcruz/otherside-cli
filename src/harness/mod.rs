//! Harness — first-class, upstream-fidelity building blocks for Anthropic
//! request bodies.
//!
//! # Why this module exists
//!
//! The outbound `/v1/messages` body is composed of four byte-verbatim
//! fidelity anchors plus per-request user content:
//!
//! 1. **System blocks** — billing header + two pre-prompt blocks + the
//!    ~16KB main agent system prompt. Captured from live upstream traffic
//!    (Claude Code 2.1.113, 2026-04-18).
//! 2. **System-reminder blocks** — three `<system-reminder>`-wrapped text
//!    blocks prepended to the first user turn: deferred-tools notice,
//!    skills catalog, user-context (email + date).
//! 3. **Tool schemas** — 9-entry `tools[]` array in canonical order
//!    (`Agent, Bash, Edit, Glob, Grep, Read, Skill, ToolSearch, Write`).
//! 4. **Envelope defaults** — `metadata` + `max_tokens` + `thinking` +
//!    `context_management` + `output_config` + `stream` in capture key
//!    order.
//!
//! Each piece lives in its own file under `otherside-cli/harness_corpus/`
//! and is embedded here via `include_str!` at compile time. No runtime
//! I/O. Builder fns in submodules produce `serde_json::Value` fragments
//! the translator splices into the final body.
//!
//! # `harness_corpus/` vs outer `fingerprint_corpus/`
//!
//! The harness artifacts are otherside's own working copy of the
//! upstream-faithful request pieces — the code path reads them, the
//! binary ships them. They do NOT get tagged "fingerprint"; that name
//! is reserved for `src/fingerprint/` (wire-detection surface — the
//! stuff the provider could match to ban users). Raw end-to-end
//! captures (request/response bodies scrubbed from live sessions)
//! live in outer `fingerprint_corpus/` as reference material only —
//! no code compiles against them. See `docs/design/harness-vs-
//! fingerprint.md` for the full split.
//!
//! # Zone
//!
//! Compat zone (RULES §1). Content impersonates upstream verbatim —
//! that is the function of this module. Identifiers follow R-11
//! (describe function, no upstream-product echoes in names).

pub mod envelope;
pub mod reminders;
pub mod system;
pub mod tools;

/// Raw bytes of the system-prompt (the ~16KB main agent prompt).
pub const SYSTEM_PROMPT: &str =
    include_str!("../../harness_corpus/system-prompt.md");

/// Raw JSON of the system-preamble (billing header + two pre-prompt
/// blocks as a 3-entry array).
pub const SYSTEM_PREAMBLE_JSON: &str =
    include_str!("../../harness_corpus/system-preamble.json");

/// Raw text of the deferred-tools system-reminder. Includes the
/// `<system-reminder>` wrapper. Byte-verbatim from capture.
pub const REMINDER_DEFERRED_TOOLS: &str =
    include_str!("../../harness_corpus/system-reminders/deferred-tools.txt");

/// Raw text of the skills system-reminder. Includes the
/// `<system-reminder>` wrapper plus one trailing `\n`.
pub const REMINDER_SKILLS: &str =
    include_str!("../../harness_corpus/system-reminders/skills.txt");

/// Raw template of the user-context system-reminder with `{{email}}`
/// and `{{current_date}}` placeholders. Includes wrapper + two trailing
/// `\n`s (byte-verbatim from capture minus the two literal
/// substitutions).
pub const REMINDER_USER_CONTEXT_TMPL: &str =
    include_str!("../../harness_corpus/system-reminders/user-context.tmpl");

/// Raw JSON of the envelope defaults (metadata, max_tokens, thinking,
/// context_management, output_config, stream).
pub const ENVELOPE_JSON: &str =
    include_str!("../../harness_corpus/envelope.json");

/// Raw JSON for tool `Agent`.
pub const TOOL_AGENT_JSON: &str =
    include_str!("../../harness_corpus/tools/Agent.json");
/// Raw JSON for tool `Bash`.
pub const TOOL_BASH_JSON: &str =
    include_str!("../../harness_corpus/tools/Bash.json");
/// Raw JSON for tool `Edit`.
pub const TOOL_EDIT_JSON: &str =
    include_str!("../../harness_corpus/tools/Edit.json");
/// Raw JSON for tool `Glob`.
pub const TOOL_GLOB_JSON: &str =
    include_str!("../../harness_corpus/tools/Glob.json");
/// Raw JSON for tool `Grep`.
pub const TOOL_GREP_JSON: &str =
    include_str!("../../harness_corpus/tools/Grep.json");
/// Raw JSON for tool `Read`.
pub const TOOL_READ_JSON: &str =
    include_str!("../../harness_corpus/tools/Read.json");
/// Raw JSON for tool `Skill`.
pub const TOOL_SKILL_JSON: &str =
    include_str!("../../harness_corpus/tools/Skill.json");
/// Raw JSON for tool `ToolSearch`.
pub const TOOL_TOOL_SEARCH_JSON: &str =
    include_str!("../../harness_corpus/tools/ToolSearch.json");
/// Raw JSON for tool `Write`.
pub const TOOL_WRITE_JSON: &str =
    include_str!("../../harness_corpus/tools/Write.json");

/// Canonical tool-name order as upstream advertises on the wire
/// (verified against `fingerprint_corpus/tools-glob-single/turn1/request.body.json`).
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
