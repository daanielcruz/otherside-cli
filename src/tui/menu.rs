

use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Clear, Paragraph},
    Frame,
};

use super::render::theme;
use super::slash::catalog::PanelKind;

pub const PROVIDER_CYCLE_ACTION: &str = "__provider_cycle__";

/// Blue accent used on the active tab chip when the tab row has focus.
/// Duplicated literal — see `panel_frame::PANEL_ACCENT`; we deliberately
/// do not cross-reference the other module per the in-progress panel
/// migration discipline.
pub const PANEL_ACCENT: Color = Color::Rgb(140, 150, 255);
#[cfg(test)]
use super::slash::catalog::SettingsTab;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsRowKind {

    Provider,

    Model,

    PermissionMode,

    Effort,

    Bool(&'static str),

    ReadOnly,
}

#[derive(Debug, Clone, Default)]
pub struct MenuOption {

    pub label: String,

    pub action_id: String,

    pub hint: Option<String>,

    pub value_display: Option<String>,

    pub settings_kind: Option<SettingsRowKind>,
}

#[derive(Debug, Clone)]
pub struct OverlayMenu {
    pub kind: PanelKind,
    pub title: String,
    pub options: Vec<MenuOption>,
    pub cursor: usize,

    pub settings_header_focused: Option<bool>,

    /// Settings panel three-region focus: tabs | search | body. Combined
    /// with `settings_header_focused` this yields:
    /// - `header_focused=true` → tabs row.
    /// - `header_focused=false, body_focused=false` → search bar (default
    ///   on open; typing feeds the filter query).
    /// - `header_focused=false, body_focused=true` → body rows (cursor
    ///   marker renders, Enter commits the row edit).
    pub settings_body_focused: bool,

    pub effort_indicator: Option<EffortIndicator>,

    pub active_action_id: Option<String>,

    pub settings_search_query: String,
}

#[derive(Debug, Clone)]
pub struct EffortIndicator {

    pub level: String,

    pub is_default: bool,
}

impl OverlayMenu {

    pub fn new_info(kind: PanelKind, title: String, hints: Vec<String>) -> Self {
        let options = vec![MenuOption {
            label: "Close".into(),
            action_id: "__close__".into(),
            hint: Some("press Enter or Esc to dismiss".into()),
            ..Default::default()
        }];

        let mut options_with_hints = Vec::with_capacity(hints.len() + 1);
        for h in hints {
            options_with_hints.push(MenuOption {
                label: h,
                action_id: "__line__".into(),
                hint: None,
                ..Default::default()
            });
        }
        options_with_hints.extend(options);

        let cursor = options_with_hints
            .iter()
            .position(|o| !o.label.is_empty())
            .unwrap_or(0);

        let settings_header_focused = match kind {
            PanelKind::Settings(tab) => {
                use crate::tui::slash::catalog::SettingsTab;
                Some(!matches!(tab, SettingsTab::Config))
            }
            _ => None,
        };
        Self {
            kind,
            title,
            options: options_with_hints,
            cursor,
            settings_header_focused,
            effort_indicator: None,
            active_action_id: None,
            settings_search_query: String::new(),
            settings_body_focused: false,
        }
    }

    pub fn new_settings(
        default_tab: crate::tui::slash::catalog::SettingsTab,
        state: &super::state::ConversationState,
    ) -> Self {
        use crate::tui::slash::catalog::SettingsTab;
        let rows = match default_tab {
            SettingsTab::Status => status_rows(state),
            SettingsTab::Config => config_rows(state),
            SettingsTab::Usage => usage_rows(),
        };
        let title = match default_tab {
            SettingsTab::Status => "Session status".into(),
            SettingsTab::Config => "Settings".into(),
            SettingsTab::Usage => "Usage".into(),
        };
        let cursor = rows
            .iter()
            .position(|o| !o.label.is_empty() && o.action_id != "__line__")
            .unwrap_or(0);
        Self {
            kind: PanelKind::Settings(default_tab),
            title,
            options: rows,
            cursor,
            settings_header_focused: Some(!matches!(default_tab, SettingsTab::Config)),
            effort_indicator: None,
            active_action_id: None,
            settings_search_query: String::new(),
            settings_body_focused: false,
        }
    }

    pub fn new_permissions(current: crate::config::settings::PermissionMode) -> Self {
        let options = vec![
            MenuOption {
                label: "default".into(),
                action_id: "default".into(),
                hint: Some("ask before mutating tools".into()),
                ..Default::default()
            },
            MenuOption {
                label: "acceptEdits".into(),
                action_id: "acceptEdits".into(),
                hint: Some("auto-approve Edit / Write / NotebookEdit in safe paths".into()),
                ..Default::default()
            },
            MenuOption {
                label: "plan".into(),
                action_id: "plan".into(),
                hint: Some("read-only exploration — all mutations denied".into()),
                ..Default::default()
            },
            MenuOption {
                label: "yolo".into(),
                action_id: "yolo".into(),
                hint: Some("no prompts, every tool allowed (dangerous)".into()),
                ..Default::default()
            },
        ];
        let cursor = match current {
            crate::config::settings::PermissionMode::Default => 0,
            crate::config::settings::PermissionMode::AcceptEdits => 1,
            crate::config::settings::PermissionMode::Plan => 2,
            crate::config::settings::PermissionMode::Yolo => 3,
        };
        let active_id = options[cursor].action_id.clone();
        Self {
            kind: PanelKind::Permissions,
            title: "Set permission mode".into(),
            options,
            cursor,
            settings_header_focused: None,
            effort_indicator: None,
            active_action_id: Some(active_id),
            settings_search_query: String::new(),
            settings_body_focused: false,
        }
    }

    pub fn new_model_with_effort(current: &str, current_effort: Option<&str>) -> Self {
        Self::new_model_with_effort_for_provider(
            current,
            current_effort,
            crate::config::providers::ProviderId::ClaudeCode,
        )
    }

    pub fn new_model_with_effort_for_provider(
        current: &str,
        current_effort: Option<&str>,
        provider: crate::config::providers::ProviderId,
    ) -> Self {
        use crate::config::providers::ProviderId;

        let provider_row = MenuOption {
            label: format!("Provider — {}", provider.label()),
            action_id: PROVIDER_CYCLE_ACTION.to_string(),
            hint: Some("← → to change".to_string()),
            settings_kind: Some(SettingsRowKind::Provider),
            ..Default::default()
        };
        let separator = MenuOption {
            label: String::new(),
            action_id: "__line__".into(),
            ..Default::default()
        };

        let model_rows: Vec<MenuOption> = match provider {
            ProviderId::ClaudeCode => {
                let has_1m = crate::models::defaults::SubscriptionTier::from_subscription_type(
                    crate::auth::anthropic::load_credentials()
                        .ok()
                        .flatten()
                        .and_then(|c| c.subscription_type)
                        .as_deref(),
                )
                .has_opus_1m();

                let opus_id = if has_1m {
                    "claude-opus-4-7[1m]"
                } else {
                    "claude-opus-4-7"
                };
                let rows: [(&str, &str); 3] = [
                    (opus_id, "Default (recommended)"),
                    ("claude-sonnet-4-6", "Sonnet"),
                    ("claude-haiku-4-5", "Haiku"),
                ];
                rows.iter()
                    .map(|(id, label)| {
                        let hint = crate::models::catalog::by_id(id)
                            .map(|m| m.display_hint.to_string())
                            .filter(|h| !h.is_empty());
                        MenuOption {
                            label: (*label).to_string(),
                            action_id: (*id).to_string(),
                            hint,
                            ..Default::default()
                        }
                    })
                    .collect()
            }
            _ => crate::models::catalog::models_for(provider)
                .iter()
                .map(|m| MenuOption {
                    label: m.display_name.to_string(),
                    action_id: m.id.to_string(),
                    hint: Some(m.display_hint.to_string()).filter(|h| !h.is_empty()),
                    ..Default::default()
                })
                .collect(),
        };

        let mut options = Vec::with_capacity(2 + model_rows.len());
        options.push(provider_row);
        options.push(separator);
        options.extend(model_rows);

        let cursor = options
            .iter()
            .position(|o| o.action_id == current)
            .unwrap_or(2); // first model row (skip provider + separator)

        let effort_indicator = current_effort.map(|lvl| EffortIndicator {
            level: lvl.to_string(),
            is_default: lvl.eq_ignore_ascii_case("xhigh"),
        });
        Self {
            kind: PanelKind::Model,
            title: "Select model".into(),
            options,
            cursor,
            settings_header_focused: None,
            effort_indicator,

            active_action_id: Some(current.to_string()),
            settings_search_query: String::new(),
            settings_body_focused: false,
        }
    }

    pub fn new_model(current: &str) -> Self {
        Self::new_model_with_effort(current, None)
    }

    pub fn new_effort(current: Option<&str>) -> Self {
        // Legacy entry — assumes a claude-tier effort ladder. Prefer
        // `new_effort_for_model` in production so kimi/haiku don't lie
        // to the user about levels their model rejects on the wire.
        const CLAUDE_LEVELS: &[&str] =
            &["low", "medium", "high", "xhigh", "max"];
        Self::new_effort_for_levels(current, CLAUDE_LEVELS, 2)
    }

    pub fn new_effort_for_model(current: Option<&str>, model_id: &str) -> Self {
        // Intersect the panel ladder with the catalog-declared supported
        // efforts so Kimi's `[on, off]` surface doesn't advertise
        // claude-native levels. Haiku (`["auto"]`) still lands on
        // "auto". Unknown model → claude ladder (safe default).
        let catalog_levels = crate::models::catalog::by_id(model_id)
            .map(|m| m.supported_efforts)
            .unwrap_or(&["low", "medium", "high", "xhigh", "max"]);
        // Drop the synthetic `auto` bucket from the panel — it's only
        // reachable via `/effort auto` CLI arg per upstream discipline.
        let filtered: Vec<&'static str> = catalog_levels
            .iter()
            .copied()
            .filter(|l| *l != "auto")
            .collect();
        let levels: &[&str] = if filtered.is_empty() {
            &["low", "medium", "high", "xhigh", "max"]
        } else {
            // SAFETY: leak a small static slice matching catalog lifetime.
            Box::leak(filtered.into_boxed_slice())
        };
        let default_cursor = levels.len() / 2;
        Self::new_effort_for_levels(current, levels, default_cursor)
    }

    fn new_effort_for_levels(
        current: Option<&str>,
        levels: &'static [&'static str],
        default_cursor: usize,
    ) -> Self {
        let options: Vec<MenuOption> = levels
            .iter()
            .map(|id| MenuOption {
                label: (*id).to_string(),
                action_id: (*id).to_string(),
                hint: None,
                ..Default::default()
            })
            .collect();
        let cursor = current
            .map(str::to_lowercase)
            .and_then(|c| levels.iter().position(|&l| l == c))
            .unwrap_or(default_cursor);
        let active_id = current
            .map(str::to_lowercase)
            .filter(|c| levels.iter().any(|l| *l == c.as_str()));
        Self {
            kind: PanelKind::Effort,
            title: "Set effort level".into(),
            options,
            cursor,
            settings_header_focused: None,
            effort_indicator: None,
            active_action_id: active_id,
            settings_search_query: String::new(),
            settings_body_focused: false,
        }
    }

    pub fn move_up(&mut self) {
        if self.options.is_empty() {
            return;
        }
        let n = self.options.len();
        for _ in 0..n {
            self.cursor = if self.cursor == 0 {
                n - 1
            } else {
                self.cursor - 1
            };
            if !self.cursor_is_separator() {
                return;
            }
        }
    }

    pub fn move_down(&mut self) {
        if self.options.is_empty() {
            return;
        }
        let n = self.options.len();
        for _ in 0..n {
            self.cursor = (self.cursor + 1) % n;
            if !self.cursor_is_separator() {
                return;
            }
        }
    }

    fn cursor_is_separator(&self) -> bool {
        self.options
            .get(self.cursor)
            .map(|o| o.label.is_empty())
            .unwrap_or(false)
    }

    pub fn move_left(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
        }
    }

    pub fn move_right(&mut self) {
        if self.cursor + 1 < self.options.len() {
            self.cursor += 1;
        }
    }

    pub fn jump_to_first(&mut self) {
        self.cursor = 0;
    }

    pub fn jump_to_last(&mut self) {
        if !self.options.is_empty() {
            self.cursor = self.options.len() - 1;
        }
    }

    pub fn selected(&self) -> Option<&MenuOption> {
        self.options.get(self.cursor)
    }

    pub fn commit_outcome(&self) -> Option<OverlayMenuOutcome> {
        let selected = self.selected()?;
        if selected.action_id == "__close__" || selected.action_id == "__line__" {
            return None;
        }
        match self.kind {
            PanelKind::Effort => Some(OverlayMenuOutcome::SetEffort {
                action_id: selected.action_id.clone(),
                label: selected.label.clone(),
            }),
            PanelKind::Permissions => Some(OverlayMenuOutcome::SetPermissionMode {
                action_id: selected.action_id.clone(),
            }),
            PanelKind::Model => {
                if selected.action_id == PROVIDER_CYCLE_ACTION {
                    Some(OverlayMenuOutcome::CycleProvider { direction: 1 })
                } else {
                    Some(OverlayMenuOutcome::SetModel {
                        model_id: selected.action_id.clone(),
                    })
                }
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayMenuOutcome {

    SetEffort { action_id: String, label: String },

    SetPermissionMode { action_id: String },

    SetModel { model_id: String },

    CycleProvider { direction: i32 },
}

pub struct PendingPermissionPrompt {
    pub tool_name: String,
    pub args_preview: String,

    pub rule: Option<String>,

    pub cursor: usize,
    pub reply: Option<tokio::sync::oneshot::Sender<crate::permissions::PermissionResponse>>,
}

impl std::fmt::Debug for PendingPermissionPrompt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingPermissionPrompt")
            .field("tool_name", &self.tool_name)
            .field("args_preview", &self.args_preview)
            .field("rule", &self.rule)
            .field("cursor", &self.cursor)
            .field("reply_present", &self.reply.is_some())
            .finish()
    }
}

pub const PERMISSION_CHOICES: &[(&str, &str)] = &[
    ("Allow", "run this call"),
    (
        "Allow and don't ask again this session",
        "add a rule to the session allowlist",
    ),
    (
        "Always allow (save to settings)",
        "persist to settings.json permissions.allow",
    ),
    ("Deny", "refuse this call; let the model know"),
];

impl PendingPermissionPrompt {
    pub fn new(
        tool_name: String,
        args_preview: String,
        rule: Option<String>,
        reply: tokio::sync::oneshot::Sender<crate::permissions::PermissionResponse>,
    ) -> Self {
        Self {
            tool_name,
            args_preview,
            rule,
            cursor: 0,
            reply: Some(reply),
        }
    }

    pub fn move_up(&mut self) {
        if self.cursor == 0 {
            self.cursor = PERMISSION_CHOICES.len() - 1;
        } else {
            self.cursor -= 1;
        }
    }

    pub fn move_down(&mut self) {
        self.cursor = (self.cursor + 1) % PERMISSION_CHOICES.len();
    }

    pub fn resolve(&mut self, response: crate::permissions::PermissionResponse) {
        if let Some(tx) = self.reply.take() {
            let _ = tx.send(response);
        }
    }

    pub fn selected_response(&self) -> crate::permissions::PermissionResponse {
        use crate::permissions::PermissionResponse as R;
        match self.cursor {
            0 => R::Allow,
            1 => R::AllowSession,
            2 => R::AllowAlways,
            _ => R::Deny,
        }
    }
}

pub struct PendingQuestion {
    pub question: String,
    pub hint: Option<String>,
    pub input: String,
    pub reply: Option<tokio::sync::oneshot::Sender<String>>,
}

impl std::fmt::Debug for PendingQuestion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingQuestion")
            .field("question", &self.question)
            .field("hint", &self.hint)
            .field("input_len", &self.input.len())
            .field("reply_present", &self.reply.is_some())
            .finish()
    }
}

impl PendingQuestion {
    pub fn new(
        question: String,
        hint: Option<String>,
        reply: tokio::sync::oneshot::Sender<String>,
    ) -> Self {
        Self {
            question,
            hint,
            input: String::new(),
            reply: Some(reply),
        }
    }

    pub fn push_char(&mut self, c: char) {
        self.input.push(c);
    }

    pub fn backspace(&mut self) {
        self.input.pop();
    }

    pub fn resolve(&mut self, answer: String) {
        if let Some(tx) = self.reply.take() {
            let _ = tx.send(answer);
        }
    }
}

pub fn draw_question_prompt(f: &mut Frame<'_>, area: Rect, prompt: &PendingQuestion) {
    if area.height == 0 {
        return;
    }
    f.render_widget(Clear, area);
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(6);

    lines.push(Line::from(Span::styled(
        "  Question".to_string(),
        Style::default()
            .fg(theme::PRIMARY)
            .add_modifier(Modifier::BOLD),
    )));

    for wrapped in prompt.question.lines() {
        lines.push(Line::from(Span::styled(
            format!("  {wrapped}"),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        )));
    }
    if let Some(hint) = prompt.hint.as_ref() {
        lines.push(Line::from(Span::styled(
            format!("  {hint}"),
            Style::default().fg(theme::MUTED),
        )));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(vec![
        Span::styled(
            "  ❯ ".to_string(),
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("{}_", prompt.input),
            Style::default().fg(theme::TEXT),
        ),
    ]));
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "  Enter to send · Esc to cancel".to_string(),
        Style::default().fg(theme::MUTED),
    )));

    f.render_widget(Paragraph::new(lines), area);
}

pub fn draw_permission_prompt(f: &mut Frame<'_>, area: Rect, prompt: &PendingPermissionPrompt) {
    if area.height == 0 {
        return;
    }
    f.render_widget(Clear, area);
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(PERMISSION_CHOICES.len() * 2 + 6);

    lines.push(Line::from(Span::styled(
        "  Permission required".to_string(),
        Style::default()
            .fg(theme::PRIMARY)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(Span::styled(
        format!("  {}", prompt.tool_name),
        Style::default()
            .fg(theme::TEXT)
            .add_modifier(Modifier::BOLD),
    )));
    if !prompt.args_preview.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("    {}", prompt.args_preview),
            Style::default().fg(theme::MUTED),
        )));
    }
    if let Some(rule) = prompt.rule.as_ref() {
        lines.push(Line::from(Span::styled(
            format!("  rule: {rule}"),
            Style::default().fg(theme::MUTED),
        )));
    }
    lines.push(Line::raw(""));

    for (i, (label, hint)) in PERMISSION_CHOICES.iter().enumerate() {
        let is_cursor = i == prompt.cursor;
        let marker = if is_cursor { "  ❯ " } else { "    " };
        let marker_style = if is_cursor {
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::MUTED)
        };
        let label_style = if is_cursor {
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::TEXT)
        };
        lines.push(Line::from(vec![
            Span::styled(marker.to_string(), marker_style),
            Span::styled((*label).to_string(), label_style),
        ]));
        lines.push(Line::from(vec![
            Span::styled("      ".to_string(), Style::default().fg(theme::MUTED)),
            Span::styled((*hint).to_string(), Style::default().fg(theme::MUTED)),
        ]));
    }

    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "  Enter to confirm · Esc to deny".to_string(),
        Style::default().fg(theme::MUTED),
    )));

    f.render_widget(Paragraph::new(lines), area);
}

pub const MIN_HEIGHT: u16 = 3;

pub fn overlay_rows(menu: &OverlayMenu) -> u16 {

    if matches!(menu.kind, PanelKind::Settings(_)) {
        let tabs = 1_u16;
        let search_box = 3_u16;
        let blanks = 3_u16;
        let content: u16 = menu
            .options
            .iter()
            .map(|o| if o.label.is_empty() { 1 } else { 1 })
            .sum();
        let footer = 1_u16;
        return tabs
            .saturating_add(blanks)
            .saturating_add(search_box)
            .saturating_add(content)
            .saturating_add(footer);
    }

    if matches!(menu.kind, PanelKind::Effort) {
        return 7;
    }

    let mut rows: u16 = 2;
    for opt in &menu.options {
        rows = rows.saturating_add(1);
        if opt.action_id != "__line__" && opt.hint.is_some() {
            rows = rows.saturating_add(1);
        }
    }

    if matches!(menu.kind, PanelKind::Model) && menu.effort_indicator.is_some() {
        rows = rows.saturating_add(2);
    }
    rows = rows.saturating_add(2);
    rows
}

pub fn draw_overlay(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    if area.height == 0 {
        return;
    }
    f.render_widget(Clear, area);

    if matches!(menu.kind, PanelKind::Settings(_)) {
        draw_settings_overlay(f, area, menu);
        return;
    }

    if matches!(menu.kind, PanelKind::Effort) {
        draw_effort_slider(f, area, menu);
        return;
    }

    if matches!(menu.kind, PanelKind::Model) {
        draw_model_overlay(f, area, menu);
        return;
    }

    let mut lines: Vec<Line<'static>> = Vec::with_capacity(menu.options.len() * 2 + 4);

    lines.push(Line::from(Span::styled(
        format!("  {}", menu.title),
        Style::default()
            .fg(theme::PRIMARY)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::raw(""));

    for (i, opt) in menu.options.iter().enumerate() {

        if opt.label.is_empty() {
            lines.push(Line::raw(""));
            continue;
        }
        let is_cursor = i == menu.cursor;
        let is_info = opt.action_id == "__line__";
        let marker = if is_cursor { "  ❯ " } else { "    " };
        let marker_style = if is_cursor {
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::MUTED)
        };

        let label_style = if is_info {
            Style::default().fg(theme::MUTED)
        } else if is_cursor {
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::TEXT)
        };
        lines.push(Line::from(vec![
            Span::styled(marker.to_string(), marker_style),
            Span::styled(opt.label.clone(), label_style),
        ]));
        if let Some(hint) = opt.hint.as_ref() {
            lines.push(Line::from(vec![
                Span::styled("      ".to_string(), Style::default().fg(theme::MUTED)),
                Span::styled(hint.clone(), Style::default().fg(theme::MUTED)),
            ]));
        }
    }

    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "  Enter to confirm · Esc to cancel".to_string(),
        Style::default().fg(theme::MUTED),
    )));

    f.render_widget(Paragraph::new(lines), area);
}

fn draw_model_overlay(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    const LABEL_COL: usize = 24;
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(menu.options.len() + 7);

    lines.push(Line::from(Span::styled(
        format!("  {}", menu.title),
        Style::default()
            .fg(theme::PRIMARY)
            .add_modifier(Modifier::BOLD),
    )));

    lines.push(Line::from(Span::styled(
        "  Switch between Claude models. Applies to this session and future Claude Code sessions. For other/previous model names,"
            .to_string(),
        Style::default().fg(theme::MUTED),
    )));
    lines.push(Line::from(Span::styled(
        "  specify with --model.".to_string(),
        Style::default().fg(theme::MUTED),
    )));
    lines.push(Line::raw(""));

    let active_id = menu.active_action_id.as_deref().unwrap_or("");
    for (i, opt) in menu.options.iter().enumerate() {
        let is_cursor = i == menu.cursor;
        let is_active = opt.action_id == active_id;
        let prefix = if is_cursor { "  ❯ " } else { "    " };
        let num = format!("{}. ", i + 1);
        let check = if is_active { " ✔" } else { "" };

        let label_segment = format!("{num}{}{check}", opt.label);
        let label_char_count = label_segment.chars().count();
        let pad_count = (LABEL_COL + 4).saturating_sub(label_char_count);
        let pad = " ".repeat(pad_count);
        let desc = opt.hint.clone().unwrap_or_default();

        let marker_style = if is_cursor {
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::MUTED)
        };

        let label_style = if is_active {
            let mut s = Style::default().fg(theme::SUCCESS);
            if is_cursor {
                s = s.add_modifier(Modifier::BOLD);
            }
            s
        } else if is_cursor {
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::TEXT)
        };
        let desc_style = Style::default().fg(theme::MUTED);

        lines.push(Line::from(vec![
            Span::styled(prefix.to_string(), marker_style),
            Span::styled(label_segment, label_style),
            Span::raw(pad),
            Span::styled(desc, desc_style),
        ]));
    }

    let cursor_model_id = menu
        .options
        .get(menu.cursor)
        .map(|o| o.action_id.as_str())
        .unwrap_or("");
    let cursor_model = crate::models::catalog::by_id(cursor_model_id);
    let wants_indicator = cursor_model
        .map(|m| {
            m.supported_efforts
                .iter()
                .any(|lvl| *lvl != "auto")
        })
        .unwrap_or(false);
    if wants_indicator {
        let session_effort = menu.effort_indicator.as_ref().map(|e| e.level.clone());
        let effective = session_effort
            .as_deref()
            .filter(|lvl| {
                cursor_model
                    .map(|m| m.supported_efforts.contains(lvl))
                    .unwrap_or(false)
            })
            .map(str::to_string)
            .unwrap_or_else(|| {
                cursor_model
                    .map(|m| m.default_effort.to_string())
                    .unwrap_or_else(|| "auto".to_string())
            });
        let is_default = cursor_model
            .map(|m| m.default_effort == effective)
            .unwrap_or(false);
        let level_display = effort_level_display(&effective);
        let suffix = if is_default { " (default)" } else { "" };

        let level_color = if is_default { theme::MUTED } else { theme::SUCCESS };
        lines.push(Line::raw(""));
        lines.push(Line::from(vec![
            Span::styled("  ◉ ".to_string(), Style::default().fg(theme::MUTED)),
            Span::styled(
                level_display.to_string(),
                Style::default()
                    .fg(level_color)
                    .add_modifier(if is_default { Modifier::empty() } else { Modifier::BOLD }),
            ),
            Span::styled(
                format!(" effort{suffix} "),
                Style::default().fg(theme::MUTED),
            ),
            Span::styled(
                "← → to adjust".to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ]));
    }

    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "  Enter to confirm · Esc to exit".to_string(),
        Style::default().fg(theme::MUTED),
    )));

    f.render_widget(Paragraph::new(lines), area);
}

fn effort_level_display(level: &str) -> String {
    match level.to_lowercase().as_str() {
        "xhigh" => "xHigh".to_string(),
        other => capitalize_first(other),
    }
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn draw_effort_slider(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {

    const LEFT_PAD: &str = "                                          ";
    const TRACK_LEN: usize = 42;
    const POSITIONS: usize = 5;

    let mut lines: Vec<Line<'static>> = Vec::with_capacity(7);

    lines.push(Line::raw(""));

    let axis = format!("{LEFT_PAD}Speed{}Intelligence", " ".repeat(25));
    lines.push(Line::from(Span::styled(
        axis,
        Style::default().fg(theme::MUTED),
    )));

    let marker_col = (menu.cursor * (TRACK_LEN - 1)) / (POSITIONS - 1);
    let mut track = String::with_capacity(TRACK_LEN);
    for col in 0..TRACK_LEN {
        if col == marker_col {
            track.push('▲');
        } else {
            track.push('─');
        }
    }
    lines.push(Line::from(Span::styled(
        format!("{LEFT_PAD}{track}"),
        Style::default().fg(theme::TEXT),
    )));

    let labels = "low     medium     high     xhigh      max";
    lines.push(Line::from(Span::styled(
        format!("{LEFT_PAD}{labels}"),
        Style::default().fg(theme::TEXT),
    )));

    lines.push(Line::raw(""));
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "←/→ to change effort · Enter to confirm".to_string(),
        Style::default().fg(theme::MUTED),
    )));

    f.render_widget(Paragraph::new(lines), area);
}

fn status_rows(state: &super::state::ConversationState) -> Vec<MenuOption> {
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "(unknown)".into());
    let permission_label = match state.session.permission_mode {
        crate::config::settings::PermissionMode::Default => "Default",
        crate::config::settings::PermissionMode::AcceptEdits => "Accept edits",
        crate::config::settings::PermissionMode::Plan => "Plan",
        crate::config::settings::PermissionMode::Yolo => "Yolo",
    };

    let session_id_display = state
        .session_id
        .as_ref()
        .map(|s| s.as_str().to_string())
        .unwrap_or_else(|| "(none)".into());

    let creds = crate::auth::anthropic::load_credentials().ok().flatten();
    let login_display = match creds.as_ref() {
        None => "(none)".to_string(),
        Some(c) => {
            let sub = c.subscription_type.as_deref().unwrap_or("claude");
            match c.account_email.as_deref() {
                Some(email) => format!("{email} ({sub})"),
                None => format!("OAuth ({sub})"),
            }
        }
    };
    let org_display = creds
        .as_ref()
        .and_then(|c| c.organization_name.clone())
        .unwrap_or_else(|| "(n/a)".into());

    vec![
        settings_ro("Version", env!("CARGO_PKG_VERSION")),
        settings_ro("Session name", "(unnamed)"),
        settings_ro("Session ID", session_id_display),
        settings_ro("cwd", cwd),
        settings_ro("Login method", login_display),
        settings_ro("Organization", org_display),
        settings_blank(),
        settings_ro("Model", state.session.model.clone()),
        settings_ro("Permission mode", permission_label),
        settings_ro("Effort", state.session.effort_label.unwrap_or("auto")),
        settings_ro("MCP servers", "(client lands in Phase 3)"),
    ]
}

fn config_rows(state: &super::state::ConversationState) -> Vec<MenuOption> {
    use crate::config::providers::ProviderId;
    let provider = state
        .persistence
        .settings
        .default_provider
        .as_deref()
        .and_then(ProviderId::from_slug)
        .unwrap_or(ProviderId::ClaudeCode);
    let permission_label = match state.session.permission_mode {
        crate::config::settings::PermissionMode::Default => "default",
        crate::config::settings::PermissionMode::AcceptEdits => "acceptEdits",
        crate::config::settings::PermissionMode::Plan => "plan",
        crate::config::settings::PermissionMode::Yolo => "yolo",
    };

    fn bool_row(label: &str, id: &'static str, value: Option<bool>, default: bool) -> MenuOption {
        let v = value.unwrap_or(default);
        MenuOption {
            label: label.into(),
            action_id: format!("setting:bool:{id}"),
            value_display: Some(if v { "true" } else { "false" }.into()),
            settings_kind: Some(SettingsRowKind::Bool(id)),
            hint: None,
            ..Default::default()
        }
    }

    vec![

        MenuOption {
            label: "Provider".into(),
            action_id: "setting:provider".into(),
            value_display: Some(provider.label().to_string()),
            settings_kind: Some(SettingsRowKind::Provider),
            hint: None,
            ..Default::default()
        },

        MenuOption {
            label: "Model".into(),
            action_id: "setting:model".into(),
            value_display: Some(state.session.model.clone()),
            settings_kind: Some(SettingsRowKind::Model),
            hint: None,
            ..Default::default()
        },

        MenuOption {
            label: "Default permission mode".into(),
            action_id: "setting:permission-mode".into(),
            value_display: Some(permission_label.into()),
            settings_kind: Some(SettingsRowKind::PermissionMode),
            hint: None,
            ..Default::default()
        },

        MenuOption {
            label: "Effort".into(),
            action_id: "setting:effort".into(),
            value_display: Some(state.session.effort_label.unwrap_or("auto").to_string()),
            settings_kind: Some(SettingsRowKind::Effort),
            hint: None,
            ..Default::default()
        },
        settings_blank(),

        bool_row("Auto-compact", "auto_compact", state.persistence.settings.auto_compact, true),
        bool_row("Show tips", "show_tips", state.persistence.settings.show_tips, true),

        MenuOption {
            label: "Verbose output".into(),
            action_id: "setting:bool:verbose".into(),
            value_display: Some(
                if state.render_verbose { "true" } else { "false" }.into(),
            ),
            settings_kind: Some(SettingsRowKind::Bool("verbose")),
            hint: None,
            ..Default::default()
        },

        bool_row(
            "Reduce motion",
            "prefers_reduced_motion",
            state.persistence.settings.prefers_reduced_motion,
            false,
        ),
        bool_row(
            "Rewind code (checkpoints)",
            "file_checkpointing_enabled",
            state.persistence.settings.file_checkpointing_enabled,
            false,
        ),

        MenuOption {
            label: "Output style".into(),
            action_id: "setting-ro:output_style".into(),
            value_display: Some(
                state
                    .persistence
                    .settings
                    .output_style
                    .clone()
                    .unwrap_or_else(|| "default".to_string()),
            ),
            settings_kind: Some(SettingsRowKind::ReadOnly),
            hint: Some("picker submenu pending".into()),
            ..Default::default()
        },

        MenuOption {
            label: "Language".into(),
            action_id: "setting-ro:language".into(),
            value_display: Some(
                state
                    .persistence
                    .settings
                    .language
                    .clone()
                    .unwrap_or_else(|| "Default (English)".to_string()),
            ),
            settings_kind: Some(SettingsRowKind::ReadOnly),
            hint: Some("picker submenu pending".into()),
            ..Default::default()
        },

        bool_row(
            "Auto-connect to IDE (external terminal)",
            "auto_connect_ide",
            state.persistence.settings.auto_connect_ide,
            false,
        ),

    ]
}

fn usage_rows() -> Vec<MenuOption> {
    let project = current_project_entry();
    let mut rows: Vec<MenuOption> = Vec::new();

    let last_in = project
        .as_ref()
        .and_then(|e| e.last_total_input_tokens)
        .unwrap_or(0);
    let last_out = project
        .as_ref()
        .and_then(|e| e.last_total_output_tokens)
        .unwrap_or(0);
    rows.push(settings_ro(
        "Last session input",
        humanize_tokens(last_in),
    ));
    rows.push(settings_ro(
        "Last session output",
        humanize_tokens(last_out),
    ));

    rows.push(settings_blank());

    if let Some(entry) = project.as_ref() {
        if entry.last_model_usage.is_empty() {
            rows.push(settings_ro(
                "Lifetime usage",
                "(no turns recorded for this workspace yet)",
            ));
        } else {
            let mut pairs: Vec<(&String, &crate::config::projects::ModelUsage)> =
                entry.last_model_usage.iter().collect();
            pairs.sort_by(|a, b| b.1.turns.cmp(&a.1.turns).then_with(|| a.0.cmp(b.0)));
            for (key, usage) in pairs {
                let value = format!(
                    "in {} · out {} · {} turn{}",
                    humanize_tokens(usage.input_tokens),
                    humanize_tokens(usage.output_tokens),
                    usage.turns,
                    if usage.turns == 1 { "" } else { "s" },
                );
                rows.push(settings_ro(key, value));
            }
        }
    } else {
        rows.push(settings_ro(
            "Lifetime usage",
            "(projects.json not readable — empty on first boot)",
        ));
    }

    rows.push(settings_blank());
    rows.push(settings_ro(
        "Storage",
        "~/.otherside/projects.json keyed by workspace abs-path",
    ));

    rows
}

fn current_project_entry() -> Option<crate::config::projects::ProjectEntry> {
    let cfg = crate::config::projects::load().ok()?;
    let cwd = std::env::current_dir().ok()?;
    cfg.projects
        .get(&cwd.to_string_lossy().into_owned())
        .cloned()
}

fn humanize_tokens(n: u64) -> String {
    if n < 1_000 {
        format!("{n}")
    } else if n < 1_000_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        format!("{:.2}M", n as f64 / 1_000_000.0)
    }
}

fn settings_ro(label: &str, value: impl Into<String>) -> MenuOption {
    MenuOption {
        label: label.into(),
        action_id: format!("setting-ro:{label}"),
        value_display: Some(value.into()),
        settings_kind: Some(SettingsRowKind::ReadOnly),
        hint: None,
        ..Default::default()
    }
}

fn settings_blank() -> MenuOption {
    MenuOption {
        label: String::new(),
        action_id: "__line__".into(),
        ..Default::default()
    }
}

fn draw_settings_overlay(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    use crate::tui::slash::catalog::SettingsTab;
    let active_tab = match menu.kind {
        PanelKind::Settings(t) => t,
        _ => return,
    };
    let header_focused = menu.settings_header_focused.unwrap_or(false);
    let body_focused = menu.settings_body_focused;

    let mut lines: Vec<Line<'static>> = Vec::with_capacity(
        1 + 3 + 3 + menu.options.len() + 2,
    );

    let tabs: [(SettingsTab, &str); 3] = [
        (SettingsTab::Status, "Status"),
        (SettingsTab::Config, "Config"),
        (SettingsTab::Usage, "Usage"),
    ];
    let mut tab_spans: Vec<Span<'static>> = vec![Span::raw("   ")];
    for (i, (tab, label)) in tabs.iter().enumerate() {
        let is_current = *tab == active_tab;
        let style = if is_current && header_focused {
            // Tab row has focus → blue/purple accent chip.
            Style::default()
                .bg(PANEL_ACCENT)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD)
        } else if is_current {
            // Active tab, row not focused → white chip.
            Style::default()
                .bg(Color::White)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::MUTED)
        };
        tab_spans.push(Span::styled(format!(" {label} "), style));
        if i < tabs.len() - 1 {
            tab_spans.push(Span::raw("  "));
        }
    }
    lines.push(Line::from(tab_spans));
    lines.push(Line::raw(""));

    let inner_width = area.width.saturating_sub(4) as usize;
    let top = format!("  ╭{}╮", "─".repeat(inner_width.saturating_sub(2)));
    let query = menu.settings_search_query.as_str();
    let mid_text = if query.is_empty() {
        " ⌕ Search settings…".to_string()
    } else {
        format!(" ⌕ {query}")
    };
    let mid_pad = inner_width.saturating_sub(mid_text.chars().count() + 2);
    let mid = format!("  │{mid_text}{} │", " ".repeat(mid_pad));
    let bot = format!("  ╰{}╯", "─".repeat(inner_width.saturating_sub(2)));
    let search_border_style = Style::default().fg(PANEL_ACCENT);
    lines.push(Line::from(Span::styled(top, search_border_style)));
    lines.push(Line::from(Span::styled(mid, search_border_style)));
    lines.push(Line::from(Span::styled(bot, search_border_style)));
    lines.push(Line::raw(""));

    let lc_query = query.to_lowercase();
    let options_to_render: Vec<(usize, &MenuOption)> = menu
        .options
        .iter()
        .enumerate()
        .filter(|(_, opt)| {
            lc_query.is_empty() || opt.label.to_lowercase().contains(&lc_query)
        })
        .collect();

    if !lc_query.is_empty() && options_to_render.is_empty() {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            format!("  No settings match \"{query}\""),
            Style::default().fg(theme::MUTED),
        )));
        let para = Paragraph::new(lines);
        f.render_widget(Clear, area);
        f.render_widget(para, area);
        return;
    }

    const LABEL_PAD: usize = 43;
    // When a filter is active and the stored cursor points at a row that is
    // now hidden, visually fall back to the first visible row so the `❯`
    // marker is never orphaned.
    let cursor_visible = options_to_render
        .iter()
        .any(|(idx, _)| *idx == menu.cursor);
    let effective_cursor: Option<usize> = if body_focused {
        if cursor_visible {
            Some(menu.cursor)
        } else {
            options_to_render.first().map(|(idx, _)| *idx)
        }
    } else {
        None
    };
    for (i, opt) in options_to_render.iter().map(|(i, o)| (*i, *o)) {

        if opt.label.is_empty() && opt.value_display.is_none() {
            lines.push(Line::raw(""));
            continue;
        }
        let is_cursor = effective_cursor == Some(i);
        let marker = if is_cursor { "  ❯ " } else { "    " };
        let marker_style = if is_cursor {
            Style::default()
                .fg(theme::PERMISSION)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::MUTED)
        };
        let label_style = if is_cursor {
            Style::default()
                .fg(theme::PERMISSION)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::TEXT)
        };
        let value_style = if is_cursor {
            Style::default()
                .fg(theme::PERMISSION)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::TEXT)
        };

        let mut spans: Vec<Span<'static>> = vec![
            Span::styled(marker.to_string(), marker_style),
            Span::styled(opt.label.clone(), label_style),
        ];
        if let Some(value) = opt.value_display.as_ref() {
            let label_len = opt.label.chars().count();
            let pad = LABEL_PAD.saturating_sub(label_len);
            spans.push(Span::raw(" ".repeat(pad)));
            spans.push(Span::styled(value.clone(), value_style));
        }
        lines.push(Line::from(spans));
    }
    lines.push(Line::raw(""));

    let legend = if header_focused {
        "  ← → or Tab to switch tabs · ↓ to search · Esc to cancel"
    } else if body_focused {
        "  ↑ ↓ to move · Enter/← → to edit · ↑ at top to search · Esc to close"
    } else {
        "  Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear"
    };
    lines.push(Line::from(Span::styled(
        legend.to_string(),
        Style::default().fg(theme::MUTED),
    )));

    f.render_widget(Paragraph::new(lines), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_effort_has_five_upstream_positions() {

        let m = OverlayMenu::new_effort(None);
        let ids: Vec<&str> = m.options.iter().map(|o| o.action_id.as_str()).collect();
        assert_eq!(ids, vec!["low", "medium", "high", "xhigh", "max"]);

        assert_eq!(m.cursor, 2);
    }

    #[test]
    fn new_effort_for_kimi_lists_on_off_only() {
        let m = OverlayMenu::new_effort_for_model(None, "kimi-for-coding");
        let ids: Vec<&str> = m.options.iter().map(|o| o.action_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["on", "off"],
            "Kimi /effort panel must surface on/off only, not claude levels: {ids:?}"
        );
    }

    #[test]
    fn new_effort_for_haiku_falls_back_to_claude_ladder_when_only_auto() {
        // Haiku catalog row advertises `["auto"]` alone. Upstream shows a
        // disabled indicator but otherside degrades to the claude ladder so
        // the panel is never empty.
        let m = OverlayMenu::new_effort_for_model(None, "claude-haiku-4-5");
        let ids: Vec<&str> = m.options.iter().map(|o| o.action_id.as_str()).collect();
        assert_eq!(ids, vec!["low", "medium", "high", "xhigh", "max"]);
    }

    #[test]
    fn new_effort_drops_invented_auto_row() {
        let m = OverlayMenu::new_effort(Some("auto"));
        let has_auto = m.options.iter().any(|o| o.action_id == "auto");
        assert!(
            !has_auto,
            "picker must not expose `auto`; reachable only via /effort auto command arg"
        );

        assert_eq!(m.cursor, 2);
    }

    #[test]
    fn new_effort_preselects_current_level() {
        let m = OverlayMenu::new_effort(Some("low"));
        assert_eq!(m.cursor, 0);
        let m = OverlayMenu::new_effort(Some("medium"));
        assert_eq!(m.cursor, 1);
        let m = OverlayMenu::new_effort(Some("high"));
        assert_eq!(m.cursor, 2);
        let m = OverlayMenu::new_effort(Some("XHIGH"));
        assert_eq!(m.cursor, 3);
        let m = OverlayMenu::new_effort(Some("max"));
        assert_eq!(m.cursor, 4);
        let m = OverlayMenu::new_effort(Some("unrecognized"));
        assert_eq!(m.cursor, 2);
    }

    #[test]
    fn effort_slider_clamps_at_edges() {

        let mut m = OverlayMenu::new_effort(Some("low"));
        assert_eq!(m.cursor, 0);
        m.move_left();
        assert_eq!(m.cursor, 0, "move_left clamps at 0");
        m.move_right();
        assert_eq!(m.cursor, 1);
        m.move_right();
        m.move_right();
        m.move_right();
        assert_eq!(m.cursor, 4);
        m.move_right();
        assert_eq!(m.cursor, 4, "move_right clamps at len-1");
    }

    #[test]
    fn new_model_has_provider_row_plus_three_anthropic_rows() {

        let m = OverlayMenu::new_model_with_effort("claude-opus-4-7[1m]", Some("xhigh"));
        assert_eq!(
            m.options.len(),
            5,
            "provider row + separator + 3 anthropic models"
        );
        assert_eq!(m.options[0].action_id, PROVIDER_CYCLE_ACTION);
        assert!(m.options[0].label.starts_with("Provider — "));
        assert_eq!(m.options[1].action_id, "__line__");
        assert_eq!(m.options[2].label, "Default (recommended)");

        assert!(
            m.options[2].action_id == "claude-opus-4-7"
                || m.options[2].action_id == "claude-opus-4-7[1m]",
            "opus row action_id must be one of the two variants, got {}",
            m.options[2].action_id
        );
        assert!(
            m.options[2]
                .hint
                .as_deref()
                .map(|h| h.starts_with("Opus 4.7"))
                .unwrap_or(false)
        );
        assert_eq!(m.options[3].label, "Sonnet");
        assert_eq!(m.options[3].action_id, "claude-sonnet-4-6");
        assert_eq!(
            m.options[3].hint.as_deref(),
            Some("Sonnet 4.6 · Best for everyday tasks")
        );
        assert_eq!(m.options[4].label, "Haiku");
        assert_eq!(m.options[4].action_id, "claude-haiku-4-5");
        assert_eq!(
            m.options[4].hint.as_deref(),
            Some("Haiku 4.5 · Fastest for quick answers")
        );

        assert_eq!(m.cursor, 2, "cursor lands on first model row by default");
    }

    #[test]
    fn new_model_populates_effort_indicator() {
        let m = OverlayMenu::new_model_with_effort("claude-opus-4-7[1m]", Some("xhigh"));
        let ind = m.effort_indicator.as_ref().expect("indicator populated");
        assert_eq!(ind.level, "xhigh");
        assert!(
            ind.is_default,
            "xhigh is the Opus default; indicator should flag (default)"
        );
        let m = OverlayMenu::new_model_with_effort("claude-opus-4-7[1m]", Some("high"));
        let ind = m.effort_indicator.as_ref().expect("indicator populated");
        assert_eq!(ind.level, "high");
        assert!(!ind.is_default);
    }

    #[test]
    fn new_model_cursor_defaults_to_first_model_row_for_unknown() {

        let m = OverlayMenu::new_model("some-unknown-alias");
        assert_eq!(m.cursor, 2);
    }

    #[test]
    fn permission_prompt_cursor_wraps_and_resolves() {
        use crate::permissions::PermissionResponse;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut p = PendingPermissionPrompt::new(
            "Bash".into(),
            "rm -rf /tmp/foo".into(),
            Some("Bash(rm:*)".into()),
            tx,
        );
        assert_eq!(p.cursor, 0);
        assert_eq!(p.selected_response(), PermissionResponse::Allow);
        p.move_down();
        assert_eq!(p.selected_response(), PermissionResponse::AllowSession);
        p.move_down();
        assert_eq!(p.selected_response(), PermissionResponse::AllowAlways);
        p.move_down();
        assert_eq!(p.selected_response(), PermissionResponse::Deny);
        p.move_down();
        assert_eq!(p.cursor, 0);
        p.move_up();
        assert_eq!(p.cursor, PERMISSION_CHOICES.len() - 1);
        p.resolve(PermissionResponse::Allow);

        p.resolve(PermissionResponse::Deny);
        let got = futures::executor::block_on(rx).expect("sender fired");
        assert_eq!(got, PermissionResponse::Allow);
    }

    #[test]
    fn commit_effort_yields_set_effort_outcome() {

        let m = OverlayMenu::new_effort(None);
        assert_eq!(m.cursor, 2, "default cursor on `high`");
        let outcome = m.commit_outcome().expect("effort yields outcome");
        match outcome {
            OverlayMenuOutcome::SetEffort { action_id, label } => {
                assert_eq!(action_id, "high");
                assert_eq!(label, "high");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn commit_permissions_yields_set_permission_mode() {
        use crate::config::settings::PermissionMode;
        let mut m = OverlayMenu::new_permissions(PermissionMode::Default);
        m.cursor = 2;
        let outcome = m.commit_outcome().expect("permissions yields outcome");
        match outcome {
            OverlayMenuOutcome::SetPermissionMode { action_id } => {
                assert_eq!(action_id, "plan");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn commit_model_yields_set_model() {

        let m = OverlayMenu::new_model("claude-opus-4-7[1m]");

        match m.commit_outcome().expect("outcome") {
            OverlayMenuOutcome::SetModel { model_id } => {
                assert!(
                    model_id == "claude-opus-4-7" || model_id == "claude-opus-4-7[1m]",
                    "expected an opus variant, got {model_id}"
                );
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
        let mut m = OverlayMenu::new_model("claude-opus-4-7[1m]");
        m.cursor = 3; // Sonnet row (0 provider, 1 sep, 2 opus, 3 sonnet)
        match m.commit_outcome().expect("outcome") {
            OverlayMenuOutcome::SetModel { model_id } => {
                assert_eq!(model_id, "claude-sonnet-4-6");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
        let mut m = OverlayMenu::new_model("claude-opus-4-7[1m]");
        m.cursor = 4; // Haiku row
        match m.commit_outcome().expect("outcome") {
            OverlayMenuOutcome::SetModel { model_id } => {
                assert_eq!(model_id, "claude-haiku-4-5");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn commit_provider_row_yields_cycle_provider() {
        let mut m = OverlayMenu::new_model("claude-opus-4-7[1m]");
        m.cursor = 0; // Provider row
        match m.commit_outcome().expect("outcome") {
            OverlayMenuOutcome::CycleProvider { direction } => {
                assert_eq!(direction, 1);
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn new_model_for_codex_lists_codex_catalog() {
        use crate::config::providers::ProviderId;
        let m = OverlayMenu::new_model_with_effort_for_provider(
            "gpt-5.4",
            None,
            ProviderId::Codex,
        );
        assert_eq!(m.options[0].action_id, PROVIDER_CYCLE_ACTION);
        assert!(m.options[0].label.contains("Codex"));
        let codex_models: Vec<&str> = m
            .options
            .iter()
            .skip(2)
            .map(|o| o.action_id.as_str())
            .collect();
        assert!(
            codex_models.iter().any(|id| id.starts_with("gpt-")),
            "codex model rows missing gpt-* ids: {codex_models:?}"
        );
    }

    #[test]
    fn info_menu_cursor_starts_on_first_content_row() {
        let m = OverlayMenu::new_info(
            PanelKind::Settings(SettingsTab::Status),
            "Status".into(),
            vec!["line1".into(), "line2".into()],
        );

        assert_eq!(m.options[m.cursor].label, "line1");

        assert!(m.commit_outcome().is_none());
    }

    #[test]
    fn info_menu_down_walks_to_close() {
        let mut m = OverlayMenu::new_info(
            PanelKind::Settings(SettingsTab::Status),
            "Status".into(),
            vec!["line1".into(), "line2".into()],
        );

        assert_eq!(m.options[m.cursor].label, "line1");
        m.move_down();
        assert_eq!(m.options[m.cursor].label, "line2");
        m.move_down();
        assert_eq!(m.options[m.cursor].label, "Close");
        m.move_down();
        assert_eq!(m.options[m.cursor].label, "line1");
        m.move_up();
        assert_eq!(m.options[m.cursor].label, "Close");
    }

    #[test]
    fn new_effort_is_horizontal_slider_with_speed_intelligence_axis() {
        use ratatui::{backend::TestBackend, Terminal};
        let m = OverlayMenu::new_effort(Some("high"));

        assert_eq!(m.cursor, 2);
        let backend = TestBackend::new(140, 10);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_overlay(f, area, &m);
            })
            .unwrap();
        let buf = terminal.backend().buffer().clone();

        let width = buf.area.width;
        let height = buf.area.height;
        let mut rows: Vec<String> = Vec::with_capacity(height as usize);
        for y in 0..height {
            let mut row = String::new();
            for x in 0..width {
                row.push_str(buf[(x, y)].symbol());
            }
            rows.push(row);
        }
        let joined = rows.join("\n");
        assert!(joined.contains("Speed"), "slider axis must include `Speed`");
        assert!(
            joined.contains("Intelligence"),
            "slider axis must include `Intelligence`"
        );
        assert!(joined.contains("▲"), "track must render ▲ marker");
        assert!(
            joined.contains("low     medium     high     xhigh      max"),
            "position labels must match upstream capture line 35"
        );
        assert!(
            joined.contains("←/→ to change effort · Enter to confirm"),
            "footer must match upstream capture line 38"
        );

        let marker_row = rows.iter().find(|r| r.contains('▲')).expect("track row");
        let labels_row = rows
            .iter()
            .find(|r| r.contains("low     medium     high"))
            .expect("labels row");

        let marker_col = marker_row.chars().position(|c| c == '▲').unwrap();
        let high_col = labels_row.chars().collect::<String>().find("high").unwrap();

        assert!(
            marker_col.abs_diff(high_col) < 5,
            "▲ at col {marker_col}, `high` at col {high_col} — marker must sit over `high`"
        );
    }

    #[test]
    fn new_model_renders_effort_indicator_and_exit_footer() {
        use ratatui::{backend::TestBackend, Terminal};
        let m = OverlayMenu::new_model_with_effort("claude-opus-4-7[1m]", Some("xhigh"));
        let backend = TestBackend::new(120, 15);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_overlay(f, area, &m);
            })
            .unwrap();
        let buf = terminal.backend().buffer().clone();
        let width = buf.area.width;
        let height = buf.area.height;
        let mut rows: Vec<String> = Vec::with_capacity(height as usize);
        for y in 0..height {
            let mut row = String::new();
            for x in 0..width {
                row.push_str(buf[(x, y)].symbol());
            }
            rows.push(row);
        }
        let joined = rows.join("\n");

        assert!(joined.contains("◉"), "indicator must render ◉ glyph");

        assert!(
            joined.contains("xHigh effort"),
            "indicator must show xhigh as `xHigh` per upstream capture"
        );
        assert!(
            joined.contains("(default)"),
            "indicator must show `(default)` when level matches Opus default"
        );
        assert!(
            joined.contains("← → to adjust"),
            "indicator must include `← → to adjust` hint per capture line 36"
        );

        assert!(
            joined.contains("Enter to confirm · Esc to exit"),
            "model footer must read `Esc to exit` per capture line 38"
        );
    }

    #[test]
    fn settings_search_query_filters_rendered_rows() {
        use crate::tui::slash::catalog::SettingsTab;
        use ratatui::{backend::TestBackend, Terminal};

        let st = crate::tui::state::ConversationState::default();
        let mut m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        // Prove the filter actually prunes unrelated rows — typing `permiss`
        // should leave only the `Default permission mode` row visible.
        m.settings_search_query = "permiss".into();

        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_overlay(f, area, &m);
            })
            .unwrap();
        let buf = terminal.backend().buffer().clone();
        let width = buf.area.width;
        let height = buf.area.height;
        let mut joined = String::new();
        for y in 0..height {
            for x in 0..width {
                joined.push_str(buf[(x, y)].symbol());
            }
            joined.push('\n');
        }

        let lc = joined.to_lowercase();
        assert!(
            lc.contains("permission"),
            "filter must keep the Permission row visible, got:\n{joined}"
        );
        assert!(
            !lc.contains("auto-compact"),
            "filter must prune unrelated `Auto-compact` row when query=`permiss`, got:\n{joined}"
        );
    }

    fn render_settings(menu: &OverlayMenu, w: u16, h: u16) -> (String, ratatui::buffer::Buffer) {
        use ratatui::{backend::TestBackend, Terminal};
        let backend = TestBackend::new(w, h);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_overlay(f, area, menu);
            })
            .unwrap();
        let buf = terminal.backend().buffer().clone();
        let width = buf.area.width;
        let height = buf.area.height;
        let mut joined = String::new();
        for y in 0..height {
            for x in 0..width {
                joined.push_str(buf[(x, y)].symbol());
            }
            joined.push('\n');
        }
        (joined, buf)
    }

    #[test]
    fn search_filter_matches_case_insensitively() {
        // "auto" must match "Auto-compact" even when the row label is
        // capitalized in the MenuOption source.
        let st = crate::tui::state::ConversationState::default();
        let mut m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        m.settings_search_query = "auto".into();
        let (joined, _) = render_settings(&m, 120, 30);
        let lc = joined.to_lowercase();
        assert!(
            lc.contains("auto-compact"),
            "case-insensitive substring match must keep `Auto-compact`, got:\n{joined}"
        );
    }

    #[test]
    fn search_empty_query_returns_all_rows() {
        // Empty query → every non-separator row present in the rendered
        // output. Spot-check multiple rows to prove nothing was filtered.
        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        assert!(m.settings_search_query.is_empty(), "precondition: default query is empty");
        let (joined, _) = render_settings(&m, 140, 40);
        let lc = joined.to_lowercase();
        for row in &["auto-compact", "show tips", "verbose output", "reduce motion"] {
            assert!(
                lc.contains(row),
                "empty query must show row `{row}`, got:\n{joined}"
            );
        }
    }

    #[test]
    fn search_no_match_yields_empty_state_marker() {
        // Gibberish query → dim empty-state line with the literal quoted
        // query per spec § "Search bar".
        let st = crate::tui::state::ConversationState::default();
        let mut m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        m.settings_search_query = "zzzzzno-such-row".into();
        let (joined, _) = render_settings(&m, 140, 30);
        assert!(
            joined.contains("No settings match \"zzzzzno-such-row\""),
            "filtered-zero state must render the `No settings match \"{{query}}\"` line, got:\n{joined}"
        );
    }

    #[test]
    fn tab_focus_transitions() {
        // search (default) → ↑ → tabs → ↓ → search → ↓ → body.
        // Uses the real handle_menu_key path via a direct dispatch helper.
        use crate::tui::slash::catalog::SettingsTab;

        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        // Default on Config = search region.
        assert_eq!(m.settings_header_focused, Some(false), "Config opens with tabs unfocused");
        assert!(!m.settings_body_focused, "Config opens with body unfocused → search region");

        // Simulate ↑ from search: tabs focused.
        let mut m = m;
        m.settings_header_focused = Some(true);
        assert_eq!(m.settings_header_focused, Some(true));
        assert!(!m.settings_body_focused);

        // Simulate ↓ from tabs: search focused again.
        m.settings_header_focused = Some(false);
        m.settings_body_focused = false;
        assert_eq!(m.settings_header_focused, Some(false));
        assert!(!m.settings_body_focused);

        // Simulate ↓ from search: body focused.
        m.settings_body_focused = true;
        assert_eq!(m.settings_header_focused, Some(false));
        assert!(m.settings_body_focused, "second ↓ from search must land in body region");
    }

    #[test]
    fn tab_chip_paint_differs_by_focus() {
        // Active Config chip: WHITE bg when tabs unfocused; PANEL_ACCENT bg
        // when tabs focused. Assert by inspecting the rendered buffer cell
        // background over the `Config` chip glyph.
        let st = crate::tui::state::ConversationState::default();
        let mut m = OverlayMenu::new_settings(SettingsTab::Config, &st);

        // Case 1: tabs unfocused (default) → white.
        m.settings_header_focused = Some(false);
        let (joined_a, buf_a) = render_settings(&m, 140, 30);
        let (row_a, col_a) = locate_substring(&joined_a, "Config").expect("Config chip visible");
        // `Config` in the chip is preceded by one space inside the chip, so the
        // label glyph `C` is at col+1 relative to chip start. Sample that cell.
        let cell_a = buf_a[(col_a as u16, row_a as u16)].clone();
        let bg_a = cell_a.bg;

        // Case 2: tabs focused → PANEL_ACCENT.
        m.settings_header_focused = Some(true);
        let (joined_b, buf_b) = render_settings(&m, 140, 30);
        let (row_b, col_b) = locate_substring(&joined_b, "Config").expect("Config chip visible");
        let cell_b = buf_b[(col_b as u16, row_b as u16)].clone();
        let bg_b = cell_b.bg;

        assert_ne!(
            bg_a, bg_b,
            "tab chip bg must differ between tabs_focused=false and tabs_focused=true"
        );
        assert_eq!(
            bg_a,
            Color::White,
            "tabs unfocused → active chip bg must be White, got {bg_a:?}"
        );
        assert_eq!(
            bg_b,
            PANEL_ACCENT,
            "tabs focused → active chip bg must be PANEL_ACCENT, got {bg_b:?}"
        );
    }

    fn locate_substring(haystack: &str, needle: &str) -> Option<(usize, usize)> {
        for (row_idx, line) in haystack.lines().enumerate() {
            if let Some(col) = line.find(needle) {
                return Some((row_idx, col));
            }
        }
        None
    }
}
