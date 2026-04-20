//! Central models registry.
//!
//! Single source of truth for everything model-shaped:
//! - Per-model facts ([`catalog`]): id, display_name, supports_1m,
//!   owning provider, family alias + primary-for-family flag.
//! - Alias resolver ([`aliases`]): `opus` → `claude-opus-4-7[1m]`,
//!   `sonnet` → `claude-sonnet-4-6`, etc., carrying `[1m]` across the
//!   alias boundary per upstream `utils/model/model.ts`.
//! - Per-provider default ([`defaults::default_model_for`]): returned
//!   when the user switches Provider in the Config tab.
//! - Per-agent model resolution ([`agents::resolve_agent_model`]):
//!   invocation > frontmatter > parent session, with `inherit`
//!   sentinel support.
//!
//! Consumers:
//! - `src/tui/render.rs` statusline — reads `catalog::display_name_for`
//!   + `catalog::has_1m_suffix`.
//! - `src/subagents/runner.rs` — calls `agents::resolve_agent_model`
//!   to compute the concrete wire id from the Agent tool call args.
//! - `src/tui/menu.rs` — `/model` picker lists `catalog::models_for`.
//! - `src/config/providers.rs::default_model` — delegates to
//!   [`defaults::default_model_for`].
//!
//! Philosophy: when a new model lands upstream, the ONLY file that
//! needs to change is `catalog.rs`. Everything else composes.

pub mod agents;
pub mod aliases;
pub mod catalog;
pub mod defaults;

pub use catalog::{display_name_for, has_1m_suffix, models_for, Model, CATALOG};
