//! Provider-agnostic tools — file I/O, shell, process control, planning,
//! scheduling, agent/skill dispatch. Implementations are invariant
//! across providers; the same bytes run whether the active provider is
//! claude-code, codex, gemini, or openai-custom.
//!
//! Do NOT introduce per-provider branching inside this module. If a
//! tool needs to hit an external API or has provider-specific behavior,
//! it belongs under `src/tools/api/` instead.

pub mod agent;
pub mod bash;
pub mod deferred;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod notebook;
pub mod read;
pub mod skill;
pub mod task;
pub mod tool_search;
pub mod write;
