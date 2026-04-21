

use crate::config::PermissionMode;
use crate::models::catalog;

#[derive(Debug, Clone)]
pub struct Session {

    pub model: String,

    pub effort_label: Option<&'static str>,

    pub permission_mode: PermissionMode,

    pub context_window: u64,
}

impl Session {

    pub fn new(raw_model: &str, permission_mode: PermissionMode) -> Self {
        Self {
            context_window: catalog::context_window_for(raw_model),
            permission_mode,
            model: raw_model.to_string(),
            effort_label: None,
        }
    }

    pub fn set_model(&mut self, new_raw: &str) {
        self.model = new_raw.to_string();
        self.context_window = catalog::context_window_for(new_raw);
    }

    pub fn set_effort(&mut self, label: Option<&'static str>) {
        self.effort_label = label;
    }

    pub fn cycle_permission_mode(&mut self) {
        self.permission_mode = match self.permission_mode {
            PermissionMode::AcceptEdits => PermissionMode::Plan,
            PermissionMode::Plan => PermissionMode::Yolo,
            PermissionMode::Yolo | PermissionMode::Default => PermissionMode::AcceptEdits,
        };
    }

    pub fn is_active_model(&self, id: &str) -> bool {
        self.model == id
    }

    pub fn is_active_effort(&self, level: &str) -> bool {
        matches!(self.effort_label, Some(x) if x.eq_ignore_ascii_case(level))
    }

    pub fn is_active_permission(&self, mode: PermissionMode) -> bool {
        self.permission_mode == mode
    }

    pub fn context_used_percent(&self, input_tokens: u64) -> u32 {
        if self.context_window == 0 {
            return 0;
        }
        let pct = input_tokens.saturating_mul(100) / self.context_window;
        pct.min(100) as u32
    }

    pub fn context_available(&self, input_tokens: u64) -> u64 {
        self.context_window.saturating_sub(input_tokens)
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_picks_1m_on_suffix() {
        let s = Session::new("claude-opus-4-7[1m]", PermissionMode::AcceptEdits);
        assert_eq!(s.context_window, 1_000_000);
        assert_eq!(s.context_window_label(), "1M");
    }

    #[test]
    fn new_defaults_to_200k() {
        let s = Session::new("claude-sonnet-4-6", PermissionMode::AcceptEdits);
        assert_eq!(s.context_window, 200_000);
        assert_eq!(s.context_window_label(), "200K");
    }

    #[test]
    fn set_model_reconciles_context_window() {
        let mut s = Session::new("claude-opus-4-7", PermissionMode::AcceptEdits);
        s.set_model("claude-opus-4-7[1m]");
        assert_eq!(s.context_window, 1_000_000);
        s.set_model("claude-haiku-4-5");
        assert_eq!(s.context_window, 200_000);
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
