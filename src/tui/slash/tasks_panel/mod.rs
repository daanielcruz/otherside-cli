//! `/tasks` + pill-focused ↓Enter surface.
//!
//! Upstream layers the task manager in two modes: a list of running
//! agents + shells (`BackgroundTasksDialog`) and a per-task detail dialog
//! (`AsyncAgentDetailDialog` or `ShellDetailDialog`). When the list has
//! exactly one active task the dialog auto-skips to detail.
//!
//! Otherside's legacy `/tasks` shipped a flat `OverlayMenu::new_info` —
//! read-only, no drill-in. This module replaces it with a modal
//! list-or-detail state.
//!
//! Sources:
//! - `reconstructed/2.1.117/source/components/tasks/BackgroundTasksDialog.tsx`
//! - `reconstructed/2.1.117/source/components/tasks/AsyncAgentDetailDialog.tsx`
//! - `reconstructed/2.1.117/source/components/tasks/ShellDetailDialog.tsx` (inferred)

pub mod draw;
pub mod keymap;
pub mod state;

pub use draw::draw_panel;
pub use keymap::{handle_key, KeyOutcome};
pub use state::TasksPanelState;
