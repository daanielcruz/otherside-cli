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
//! no code compiles against them.
//!
//! # Corpus layout
//!
//! ```text
//! harness_corpus/
//! ├── envelope.json              body envelope (metadata, max_tokens,
//! │                              thinking, context_management,
//! │                              output_config, stream) — capture key order
//! ├── system-prompt.md           main ~16 KB agent system prompt
//! ├── system-preamble.json       billing header + two pre-prompt blocks
//! ├── system-reminders/          three <system-reminder> blocks for turn 1
//! │   ├── deferred-tools.txt
//! │   ├── skills.txt             bundled skills catalog (distinct from
//! │                              the TUI slash catalog in docs/slashes.md)
//! │   └── user-context.tmpl      {{email}} + {{current_date}} template
//! └── tools/                     9 tool schemas, canonical order
//!     ├── Agent.json     Bash.json     Edit.json    Glob.json
//!     ├── Grep.json      Read.json     Skill.json   ToolSearch.json
//!     └── Write.json
//! ```
//!
//! # Inspection map
//!
//! | question                                          | inspect                                       |
//! |---------------------------------------------------|-----------------------------------------------|
//! | what agent instructions does the model receive?   | `system-prompt.md`                            |
//! | which billing + pre-prompt headers ride the body? | `system-preamble.json`                        |
//! | what `system-reminder` blocks prepend turn 1?     | `system-reminders/*.{txt,tmpl}`               |
//! | which tools are advertised on the wire?           | `tools/*.json` (9 files; order locked)        |
//! | what are the body envelope defaults?              | `envelope.json`                               |
//! | which TUI slashes does the binary handle?         | `docs/slashes.md` + `src/tui/slash/catalog.rs`|
//! | which SSE events does the stream emit?            | `src/translator/anthropic_to_openai.rs`       |
//!
//! # Refresh procedure
//!
//! When upstream ships a new release and the capture shape changes:
//!
//! 1. Capture a fresh `/v1/messages` request body per `capture/protocol.md`.
//! 2. Re-extract the artifacts from the scrubbed body:
//!    - `body["system"][3]["text"]` → `system-prompt.md`
//!    - `body["system"][0..3]` → `system-preamble.json` (preserve order)
//!    - Each `<system-reminder>` block from turn 1 → a file under
//!      `system-reminders/`
//!    - Each entry in `body["tools"]` → a separate `.json` under `tools/`
//!    - Remaining top-level body → `envelope.json`
//! 3. Rerun `cargo test --test harness_artifacts` — 18 byte-match tests
//!    must stay green or be updated in the same commit.
//! 4. Bump the version reference in this module's header.
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
