//! `Session` — identity of the running TUI session.
//!
//! Owns the four "which" facts: which model, which effort level, which
//! permission mode, and the context window those imply. Every read in
//! the render path, overlay constructors, and statusline MUST go
//! through this struct — see the SSOT rule in [`super`].
//!
//! # Fields and invariants
//!
//! - `model` carries the full alias the user typed (`claude-opus-4-7`,
//!   `claude-opus-4-7[1m]`). The `[1m]` suffix is *retained* here and
//!   stripped at wire time by the translator. `context_window` tracks
//!   the suffix: 1_000_000 when present, 200_000 otherwise.
//!
//! - `effort_label` snapshots the active thinking level for the
//!   progress line and the `/model` picker indicator. Set from the
//!   CLI's `(xhigh)` suffix, `/effort` commits, and reconcile-on-
//!   model-switch. `None` means "auto" / unset.
//!
//! - `permission_mode` is session-scoped; changes here never touch
//!   disk (rule §3).
//!
//! # Mutation discipline
//!
//! Mutators keep cross-field invariants synchronized in one place.
//! Callers do `session.set_model(id)` and trust `context_window` +
//! `effort_label` to reconcile — never `session.model = x` followed
//! by manual `context_window` and `effort_label` fixups.

use crate::config::PermissionMode;

const CONTEXT_WINDOW_1M: u64 = 1_000_000;
const CONTEXT_WINDOW_200K: u64 = 200_000;

#[derive(Debug, Clone)]
pub struct Session {
    /// Model alias with `[1m]` suffix retained. Wire layer strips.
    pub model: String,
    /// Active thinking level ("high" / "xhigh" / "max" / …). `None` =
    /// auto / unset / haiku (which doesn't accept a level).
    pub effort_label: Option<&'static str>,
    /// Shift+Tab cycle target. NOT persisted to settings.json.
    pub permission_mode: PermissionMode,
    /// Token budget — 1M when `model` contains `[1m]`, else 200K.
    pub context_window: u64,
}

impl Session {
    /// Fresh session sized by the model alias. `[1m]` in the raw
    /// string selects the 1M context window.
    pub fn new(raw_model: &str, permission_mode: PermissionMode) -> Self {
        Self {
            context_window: context_window_for(raw_model),
            permission_mode,
            model: raw_model.to_string(),
            effort_label: None,
        }
    }

    /// Swap the model alias mid-session. Recomputes `context_window`
    /// from the new `[1m]` suffix flag. Effort reconcile (snap to the
    /// new model's supported_efforts) lives at the AppState level
    /// because it needs to rebuild the ThinkingConfig held by the
    /// event loop — this function only touches Session-owned fields.
    pub fn set_model(&mut self, new_raw: &str) {
        self.model = new_raw.to_string();
        self.context_window = context_window_for(new_raw);
    }

    /// Update the displayed effort label. `None` = auto / unset.
    pub fn set_effort(&mut self, label: Option<&'static str>) {
        self.effort_label = label;
    }

    /// Cycle permission mode through the 3 visible stops:
    /// AcceptEdits → Plan → Yolo → AcceptEdits. The 4th mode `Default`
    /// (ask) is hidden from this cycle per directive 2026-04-20.
    pub fn cycle_permission_mode(&mut self) {
        self.permission_mode = match self.permission_mode {
            PermissionMode::AcceptEdits => PermissionMode::Plan,
            PermissionMode::Plan => PermissionMode::Yolo,
            PermissionMode::Yolo | PermissionMode::Default => PermissionMode::AcceptEdits,
        };
    }

    /// SSOT predicate for the `/model` picker ✔ checkmark and the
    /// statusline model chip. Both call this — neither snapshots the
    /// model string locally.
    pub fn is_active_model(&self, id: &str) -> bool {
        self.model == id
    }

    /// SSOT predicate for the `/effort` slider's "current" dot.
    /// `None` never matches a concrete level — callers treat unset as
    /// "no active row".
    pub fn is_active_effort(&self, level: &str) -> bool {
        matches!(self.effort_label, Some(x) if x.eq_ignore_ascii_case(level))
    }

    /// SSOT predicate for the `/permissions` picker.
    pub fn is_active_permission(&self, mode: PermissionMode) -> bool {
        self.permission_mode == mode
    }

    /// Percentage of the context window currently consumed, given the
    /// cumulative input-token count. Taking the token count as an arg
    /// keeps usage tracking on `ConversationState` — Session owns the
    /// budget, Conversation owns the consumption.
    pub fn context_used_percent(&self, input_tokens: u64) -> u32 {
        if self.context_window == 0 {
            return 0;
        }
        let pct = input_tokens.saturating_mul(100) / self.context_window;
        pct.min(100) as u32
    }

    /// Tokens remaining in the context window.
    pub fn context_available(&self, input_tokens: u64) -> u64 {
        self.context_window.saturating_sub(input_tokens)
    }

    /// Render the context-window total as `200K` / `1M` for the
    /// statusline.
    pub fn context_window_label(&self) -> String {
        match self.context_window {
            n if n >= 1_000_000 => format!("{}M", n / 1_000_000),
            n => format!("{}K", n / 1_000),
        }
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new("", PermissionMode::Default)
    }
}

/// 1M when `[1m]` suffix present (case-insensitive), 200K otherwise.
/// Mirrors upstream's `getContextWindowForModel` check.
fn context_window_for(raw_model: &str) -> u64 {
    if raw_model.to_ascii_lowercase().contains("[1m]") {
        CONTEXT_WINDOW_1M
    } else {
        CONTEXT_WINDOW_200K
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_picks_1m_on_suffix() {
        let s = Session::new("claude-opus-4-7[1m]", PermissionMode::AcceptEdits);
        assert_eq!(s.context_window, CONTEXT_WINDOW_1M);
        assert_eq!(s.context_window_label(), "1M");
    }

    #[test]
    fn new_defaults_to_200k() {
        let s = Session::new("claude-sonnet-4-6", PermissionMode::AcceptEdits);
        assert_eq!(s.context_window, CONTEXT_WINDOW_200K);
        assert_eq!(s.context_window_label(), "200K");
    }

    #[test]
    fn set_model_reconciles_context_window() {
        let mut s = Session::new("claude-opus-4-7", PermissionMode::AcceptEdits);
        s.set_model("claude-opus-4-7[1m]");
        assert_eq!(s.context_window, CONTEXT_WINDOW_1M);
        s.set_model("claude-haiku-4-5");
        assert_eq!(s.context_window, CONTEXT_WINDOW_200K);
    }

    #[test]
    fn cycle_permission_mode_skips_default() {
        let mut s = Session::new("", PermissionMode::AcceptEdits);
        s.cycle_permission_mode();
        assert_eq!(s.permission_mode, PermissionMode::Plan);
        s.cycle_permission_mode();
        assert_eq!(s.permission_mode, PermissionMode::Yolo);
        s.cycle_permission_mode();
        assert_eq!(s.permission_mode, PermissionMode::AcceptEdits);
    }

    #[test]
    fn cycle_from_hidden_default_lands_on_accept() {
        let mut s = Session::new("", PermissionMode::Default);
        s.cycle_permission_mode();
        assert_eq!(s.permission_mode, PermissionMode::AcceptEdits);
    }

    #[test]
    fn is_active_model_tracks_exact_alias() {
        let s = Session::new("claude-opus-4-7[1m]", PermissionMode::AcceptEdits);
        assert!(s.is_active_model("claude-opus-4-7[1m]"));
        assert!(!s.is_active_model("claude-opus-4-7"));
    }

    #[test]
    fn context_used_percent_clamps_at_100() {
        let s = Session::new("claude-opus-4-7", PermissionMode::AcceptEdits);
        assert_eq!(s.context_used_percent(500_000), 100);
    }
}
