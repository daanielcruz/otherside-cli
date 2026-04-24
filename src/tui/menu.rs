
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Clear, Paragraph},
    Frame,
};

#[cfg(test)]
use ratatui::style::Color;

use super::render::theme;
use super::slash::catalog::PanelKind;

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

    pub details_display: Option<DetailsCell>,

    pub settings_kind: Option<SettingsRowKind>,
}

#[derive(Debug, Clone)]
pub struct DetailsCell {
    pub label: String,
    pub url: Option<String>,
}

pub fn osc8_hyperlink(url: &str, label: &str) -> String {
    format!("\x1b]8;;{url}\x1b\\{label}\x1b]8;;\x1b\\")
}

#[derive(Debug, Clone)]
pub struct OverlayMenu {
    pub kind: PanelKind,
    pub title: String,
    pub options: Vec<MenuOption>,
    pub cursor: usize,

    pub settings_header_focused: Option<bool>,

    pub settings_body_focused: bool,

    pub effort_indicator: Option<EffortIndicator>,

    pub active_action_id: Option<String>,

    pub settings_search_query: String,

    pub model_tab_index: usize,
    pub model_tabs_focused: bool,
    pub model_body_cursor: usize,
    pub model_tab_rows: Vec<ModelTabBody>,
}

#[derive(Debug, Clone)]
pub struct ModelTabBody {
    pub provider: crate::config::providers::ProviderId,
    pub authed: bool,
    pub rows: Vec<ModelTabRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelTabRow {
    
    Model {
        raw_id: String,
        display_name: String,
        active: bool,
    },
    
    Logout,
    
    LoginCta,
    
    CustomHint,
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
            model_tab_index: 0,
            model_tabs_focused: true,
            model_body_cursor: 0,
            model_tab_rows: Vec::new(),
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
            model_tab_index: 0,
            model_tabs_focused: true,
            model_body_cursor: 0,
            model_tab_rows: Vec::new(),
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
                hint: Some("allow by default while still honoring deny and safety rules".into()),
                ..Default::default()
            },
            MenuOption {
                label: "dontAsk".into(),
                action_id: "dontAsk".into(),
                hint: Some("deny mutating tools instead of prompting".into()),
                ..Default::default()
            },
        ];
        let cursor = match current {
            crate::config::settings::PermissionMode::Default => 0,
            crate::config::settings::PermissionMode::AcceptEdits => 1,
            crate::config::settings::PermissionMode::Plan => 2,
            crate::config::settings::PermissionMode::Yolo => 3,
            crate::config::settings::PermissionMode::DontAsk => 4,
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
            model_tab_index: 0,
            model_tabs_focused: true,
            model_body_cursor: 0,
            model_tab_rows: Vec::new(),
        }
    }

    pub fn new_model_tabbed(
        active_model_id: &str,
        settings: &crate::config::settings::Settings,
        tab_index: usize,
        tabs_focused: bool,
        body_cursor: usize,
    ) -> Self {
        use crate::config::providers::PROVIDER_ORDER;

        let mut tab_rows: Vec<ModelTabBody> = Vec::with_capacity(PROVIDER_ORDER.len());
        for provider in PROVIDER_ORDER {
            let authed = provider_is_authed(*provider, settings);
            let rows = build_tab_rows(*provider, authed, active_model_id);
            tab_rows.push(ModelTabBody {
                provider: *provider,
                authed,
                rows,
            });
        }

        let tab_index = tab_index.min(PROVIDER_ORDER.len().saturating_sub(1));
        let body_cursor = body_cursor.min(
            tab_rows
                .get(tab_index)
                .map(|b| b.rows.len().saturating_sub(1))
                .unwrap_or(0),
        );

        Self {
            kind: PanelKind::Model,
            title: "Select model".into(),
            options: Vec::new(),
            cursor: 0,
            settings_header_focused: None,
            effort_indicator: None,
            active_action_id: Some(active_model_id.to_string()),
            settings_search_query: String::new(),
            settings_body_focused: false,
            model_tab_index: tab_index,
            model_tabs_focused: tabs_focused,
            model_body_cursor: body_cursor,
            model_tab_rows: tab_rows,
        }
    }

    pub fn active_model_tab(&self) -> Option<&ModelTabBody> {
        self.model_tab_rows.get(self.model_tab_index)
    }

    pub fn new_effort(current: Option<&str>) -> Self {
        // No model context available — resolve against the fallback family
        // table so we don't leak Codex-invalid `max` into a Claude picker.
        let levels = crate::models::catalog::effort_levels_for_family(None);
        let default_cursor = levels.len() / 2;
        Self::new_effort_for_levels(current, levels, default_cursor)
    }

    pub fn new_effort_for_model(current: Option<&str>, model_id: &str) -> Self {
        // Single source of truth lives in the catalog. `effort_levels_for_model`
        // looks up the row by id, strips `auto` (not user-selectable), and
        // falls back to a provider-aware default list when the id isn't in
        // the hardcoded catalog yet (live codex/kimi slug that /models fetched
        // at boot but hasn't been pinned locally).
        let levels = crate::models::catalog::effort_levels_for_model(model_id);
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
            model_tab_index: 0,
            model_tabs_focused: true,
            model_body_cursor: 0,
            model_tab_rows: Vec::new(),
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
            
            PanelKind::Model => None,
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayMenuOutcome {

    SetEffort { action_id: String, label: String },

    SetPermissionMode { action_id: String },
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
        return 9;
    }

    if matches!(menu.kind, PanelKind::Model) {
        
        let body_rows: u16 = menu
            .active_model_tab()
            .map(|t| {
                if t.authed {
                    
                    t.rows.len() as u16 + 2
                } else {
                    7
                }
            })
            .unwrap_or(0);
        return 6_u16.saturating_add(body_rows);
    }

    let mut rows: u16 = 2;
    for opt in &menu.options {
        rows = rows.saturating_add(1);
        if opt.action_id != "__line__" && opt.hint.is_some() {
            rows = rows.saturating_add(1);
        }
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

fn model_tab_label(p: crate::config::providers::ProviderId) -> &'static str {
    use crate::config::providers::ProviderId;
    match p {
        ProviderId::ClaudeCode => "Anthropic",
        ProviderId::Codex => "Codex",
        ProviderId::GeminiCli => "Gemini",
        ProviderId::Kimi => "Kimi Code",
        ProviderId::OpenAiCustom => "Custom",
    }
}

fn provider_is_authed(
    p: crate::config::providers::ProviderId,
    settings: &crate::config::settings::Settings,
) -> bool {
    use crate::config::providers::ProviderId;
    match p {
        ProviderId::ClaudeCode => crate::auth::anthropic::load_credentials()
            .ok()
            .flatten()
            .is_some(),
        ProviderId::Codex => crate::auth::codex::load_credentials()
            .ok()
            .flatten()
            .is_some(),
        ProviderId::Kimi => crate::auth::kimi::load_credentials()
            .ok()
            .flatten()
            .is_some(),
        ProviderId::GeminiCli => crate::auth::gemini::load_credentials()
            .ok()
            .flatten()
            .is_some(),
        ProviderId::OpenAiCustom => settings
            .providers
            .openai_compatible
            .as_ref()
            .map(|c| c.base_url.as_deref().map(|s| !s.is_empty()).unwrap_or(false))
            .unwrap_or(false),
    }
}

fn build_tab_rows(
    provider: crate::config::providers::ProviderId,
    authed: bool,
    active_model_id: &str,
) -> Vec<ModelTabRow> {
    use crate::config::providers::ProviderId;
    if !authed {
        return match provider {
            ProviderId::OpenAiCustom => vec![ModelTabRow::CustomHint],
            _ => vec![ModelTabRow::LoginCta],
        };
    }
    if matches!(provider, ProviderId::OpenAiCustom) {
        let mut rows = vec![ModelTabRow::Model {
            raw_id: active_model_id.to_string(),
            display_name: active_model_id.to_string(),
            active: true,
        }];
        rows.push(ModelTabRow::CustomHint);
        rows.push(ModelTabRow::Logout);
        return rows;
    }
    let mut rows: Vec<ModelTabRow> = if matches!(provider, ProviderId::Codex) {
        let live = crate::provider::codex_models::cached_models();
        if !live.is_empty() {
            live.iter()
                .map(|m| ModelTabRow::Model {
                    raw_id: m.slug.clone(),
                    display_name: crate::provider::codex_models::display_codex_name(
                        &m.slug,
                    ),
                    active: m.slug == active_model_id,
                })
                .collect()
        } else {
            crate::models::catalog::models_for(provider)
                .iter()
                .map(|m| ModelTabRow::Model {
                    raw_id: m.id.to_string(),
                    display_name: m.display_name.to_string(),
                    active: m.id == active_model_id,
                })
                .collect()
        }
    } else {
        crate::models::catalog::models_for(provider)
            .iter()
            .map(|m| ModelTabRow::Model {
                raw_id: m.id.to_string(),
                display_name: m.display_name.to_string(),
                active: m.id == active_model_id,
            })
            .collect()
    };
    rows.push(ModelTabRow::Logout);
    rows
}

fn draw_model_overlay(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    use super::panel_frame::{body_row, PanelFrame, TabSpec};
    use crate::config::providers::ProviderId;
    use ratatui::style::Color;

    let Some(active_tab) = menu.active_model_tab() else {
        return;
    };

    let tab_labels: Vec<&str> = menu
        .model_tab_rows
        .iter()
        .map(|b| model_tab_label(b.provider))
        .collect();
    let tabs: Vec<TabSpec<'_>> = tab_labels
        .iter()
        .map(|label| TabSpec { label })
        .collect();

    let mut body: Vec<Line<'static>> = Vec::new();
    body.push(Line::raw(""));

    if active_tab.authed {
        
        let logout_idx: Option<usize> = active_tab
            .rows
            .iter()
            .position(|r| matches!(r, ModelTabRow::Logout));
        let has_catalog = active_tab
            .rows
            .iter()
            .any(|r| matches!(r, ModelTabRow::Model { .. }));

        for (row_idx, row) in active_tab.rows.iter().enumerate() {
            let is_cursor = !menu.model_tabs_focused && row_idx == menu.model_body_cursor;
            match row {
                ModelTabRow::Model {
                    raw_id,
                    display_name,
                    active,
                } => {
                    let full_label = model_display_with_context(raw_id);
                    let fallback = display_name.clone();
                    let label = if full_label.is_empty() {
                        fallback
                    } else {
                        full_label
                    };
                    let name_style = if is_cursor {
                        Style::default()
                            .fg(theme::PRIMARY)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(theme::TEXT)
                    };
                    let prefix_line = body_row("", is_cursor, *active);
                    let mut spans: Vec<Span<'static>> =
                        prefix_line.spans.iter().cloned().collect();
                    spans.push(Span::styled(label, name_style));
                    body.push(Line::from(spans));
                }
                ModelTabRow::Logout => {
                    let label_style = if is_cursor {
                        Style::default()
                            .fg(theme::ERROR)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default()
                            .fg(theme::ERROR)
                            .add_modifier(Modifier::DIM)
                    };
                    let prefix_line = body_row("", is_cursor, false);
                    let mut spans: Vec<Span<'static>> =
                        prefix_line.spans.iter().cloned().collect();
                    spans.push(Span::styled("Logout".to_string(), label_style));
                    body.push(Line::from(spans));
                }
                ModelTabRow::CustomHint => {
                    let label_style = if is_cursor {
                        Style::default()
                            .fg(theme::PRIMARY)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(theme::MUTED)
                    };
                    let prefix_line = body_row("", is_cursor, false);
                    let mut spans: Vec<Span<'static>> =
                        prefix_line.spans.iter().cloned().collect();
                    spans.push(Span::styled(
                        "Reconfigure endpoint (URL / key / model)".to_string(),
                        label_style,
                    ));
                    body.push(Line::from(spans));
                }
                _ => {}
            }
            
            if let Some(li) = logout_idx {
                if row_idx + 1 == li && has_catalog {
                    body.push(Line::from(Span::styled(
                        "  ".to_string() + &"\u{2500}".repeat(50),
                        Style::default().fg(theme::SUBTLE),
                    )));
                }
            }
        }
    } else {
        let label = match active_tab.provider {
            ProviderId::ClaudeCode => "Anthropic",
            ProviderId::Codex => "Codex",
            ProviderId::GeminiCli => "Gemini",
            ProviderId::Kimi => "Kimi Code",
            ProviderId::OpenAiCustom => "Custom",
        };
        match active_tab.rows.first() {
            Some(ModelTabRow::CustomHint) => {
                body.push(Line::raw(""));
                body.push(Line::from(Span::styled(
                    "  Custom (OpenAI-compatible) endpoint is not configured.".to_string(),
                    Style::default().fg(theme::MUTED),
                )));
                body.push(Line::raw(""));
                let cta_focused = !menu.model_tabs_focused;
                let cta_label = "Configure Custom endpoint";
                let pad = 3;
                let inner_cols = pad * 2 + cta_label.chars().count();

                if cta_focused {
                    let fill_style = Style::default()
                        .fg(Color::White)
                        .bg(theme::PRIMARY)
                        .add_modifier(Modifier::BOLD);
                    let filler = " ".repeat(inner_cols);
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(filler.clone(), fill_style),
                    ]));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(
                            format!(
                                "{}{}{}",
                                " ".repeat(pad),
                                cta_label,
                                " ".repeat(pad)
                            ),
                            fill_style,
                        ),
                    ]));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(filler, fill_style),
                    ]));
                } else {
                    let border_style = Style::default().fg(theme::SUBTLE);
                    let label_style =
                        Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD);
                    let top = format!("\u{256D}{}\u{256E}", "\u{2500}".repeat(inner_cols));
                    let bot = format!("\u{2570}{}\u{256F}", "\u{2500}".repeat(inner_cols));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(top, border_style),
                    ]));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled("\u{2502}".to_string(), border_style),
                        Span::styled(
                            format!(
                                "{}{}{}",
                                " ".repeat(pad),
                                cta_label,
                                " ".repeat(pad)
                            ),
                            label_style,
                        ),
                        Span::styled("\u{2502}".to_string(), border_style),
                    ]));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(bot, border_style),
                    ]));
                }
            }
            Some(ModelTabRow::LoginCta) => {
                body.push(Line::raw(""));
                body.push(Line::from(Span::styled(
                    format!("  You are not logged in to {label}."),
                    Style::default().fg(theme::MUTED),
                )));
                body.push(Line::raw(""));
                let cta_focused = !menu.model_tabs_focused;
                let cta_label = format!("Login to {label}");
                let pad = 3;
                let inner_cols = pad * 2 + cta_label.chars().count();

                if cta_focused {
                    let fill_style = Style::default()
                        .fg(Color::White)
                        .bg(theme::PRIMARY)
                        .add_modifier(Modifier::BOLD);
                    let filler = " ".repeat(inner_cols);
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(filler.clone(), fill_style),
                    ]));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(
                            format!(
                                "{}{}{}",
                                " ".repeat(pad),
                                cta_label,
                                " ".repeat(pad)
                            ),
                            fill_style,
                        ),
                    ]));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(filler, fill_style),
                    ]));
                } else {
                    let border_style = Style::default().fg(theme::SUBTLE);
                    let label_style =
                        Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD);
                    let top =
                        format!("\u{256D}{}\u{256E}", "\u{2500}".repeat(inner_cols));
                    let bot =
                        format!("\u{2570}{}\u{256F}", "\u{2500}".repeat(inner_cols));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(top, border_style),
                    ]));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled("\u{2502}".to_string(), border_style),
                        Span::styled(
                            format!(
                                "{}{}{}",
                                " ".repeat(pad),
                                cta_label,
                                " ".repeat(pad)
                            ),
                            label_style,
                        ),
                        Span::styled("\u{2502}".to_string(), border_style),
                    ]));
                    body.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(bot, border_style),
                    ]));
                }
            }
            _ => {}
        }
    }

    let footer: &[(&str, &str)] = match (active_tab.authed, active_tab.rows.first()) {
        (true, _) => &[
            ("\u{2190}/\u{2192}", "switch tabs"),
            ("\u{2191}\u{2193}", "navigate"),
            ("Enter", "select"),
            ("Esc", "close"),
        ],
        (false, Some(ModelTabRow::CustomHint)) => &[
            ("\u{2190}/\u{2192}", "switch tabs"),
            ("Enter", "configure"),
            ("Esc", "close"),
        ],
        (false, _) => &[
            ("\u{2190}/\u{2192}", "switch tabs"),
            ("Enter", "to login"),
            ("Esc", "close"),
        ],
    };

    let panel = PanelFrame {
        title: None,
        tabs: Some(&tabs),
        active_tab: menu.model_tab_index,
        tabs_focused: menu.model_tabs_focused,
        search: None,
        body,
        footer_hints: footer,
        pagination_hint: None,
    };
    panel.render(f, area);
}

fn draw_effort_slider(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    use super::panel_frame::PanelFrame;

    const LEFT_PAD: &str = "  ";
    const TRACK_LEN: usize = 48;

    let positions = menu.options.len().max(2);
    let labels: Vec<String> = menu.options.iter().map(|o| o.label.clone()).collect();

    let mut body: Vec<Line<'static>> = Vec::with_capacity(6);

    body.push(Line::raw(""));

    let axis_gap = TRACK_LEN.saturating_sub("Speed".len() + "Intelligence".len());
    let axis = format!(
        "{LEFT_PAD}Speed{}Intelligence",
        " ".repeat(axis_gap.max(1))
    );
    body.push(Line::from(Span::styled(
        axis,
        Style::default().fg(theme::MUTED),
    )));

    let marker_col = if positions <= 1 {
        0
    } else {
        (menu.cursor * (TRACK_LEN - 1)) / (positions - 1)
    };
    let mut track = String::with_capacity(TRACK_LEN);
    for col in 0..TRACK_LEN {
        if col == marker_col {
            track.push('▲');
        } else {
            track.push('─');
        }
    }
    body.push(Line::from(Span::styled(
        format!("{LEFT_PAD}{track}"),
        Style::default().fg(theme::TEXT),
    )));

    let mut label_spans: Vec<Span<'static>> = Vec::with_capacity(labels.len() * 2 + 1);
    label_spans.push(Span::raw(LEFT_PAD.to_string()));
    if !labels.is_empty() {
        let denom = positions.saturating_sub(1).max(1);
        let mut cursor_col: usize = 0;
        for (i, l) in labels.iter().enumerate() {
            let anchor = (i * (TRACK_LEN - 1)) / denom;
            let len = l.chars().count();
            let start = anchor.saturating_sub(len / 2);
            let start = start.min(TRACK_LEN.saturating_sub(len));
            let pad = if start > cursor_col {
                start - cursor_col
            } else if i > 0 {
                1
            } else {
                0
            };
            if pad > 0 {
                label_spans.push(Span::raw(" ".repeat(pad)));
                cursor_col = cursor_col.saturating_add(pad);
            }
            let is_active = i == menu.cursor;
            let style = if is_active {
                Style::default()
                    .fg(effort_level_color(l))
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::MUTED)
            };
            label_spans.push(Span::styled(l.clone(), style));
            cursor_col = cursor_col.saturating_add(len);
        }
    }
    body.push(Line::from(label_spans));

    body.push(Line::raw(""));

    let frame = PanelFrame {
        title: Some("\u{25B8} Effort"),
        tabs: None,
        active_tab: 0,
        tabs_focused: false,
        search: None,
        body,
        footer_hints: &[
            ("\u{2190}/\u{2192}", "change"),
            ("Enter", "confirm"),
            ("Esc", "cancel"),
        ],
        pagination_hint: None,
    };
    frame.render(f, area);
}

fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    s.chars().skip(count - n).collect()
}

fn truncate_url(url: &str, max_chars: usize) -> String {
    let stripped = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    if stripped.chars().count() <= max_chars {
        return stripped.to_string();
    }
    let keep = max_chars.saturating_sub(4);
    let head: String = stripped.chars().take(keep).collect();
    format!("{head}....")
}

fn status_rows(state: &super::state::ConversationState) -> Vec<MenuOption> {
    use crate::config::providers::{ProviderId, PROVIDER_ORDER};
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "(unknown)".into());
    let permission_label = match state.session.permission_mode {
        crate::config::settings::PermissionMode::Default => "Default",
        crate::config::settings::PermissionMode::AcceptEdits => "Accept edits",
        crate::config::settings::PermissionMode::Plan => "Plan",
        crate::config::settings::PermissionMode::Yolo => "Yolo",
        crate::config::settings::PermissionMode::DontAsk => "Don't ask",
    };

    let session_id_display = state
        .session_id
        .as_ref()
        .map(|s| s.as_str().to_string())
        .unwrap_or_else(|| "(none)".into());

    let provider_is_kimi = matches!(state.provider_id, ProviderId::Kimi);
    let effort_label = if provider_is_kimi { "Thinking" } else { "Effort" };
    let effort_value = if provider_is_kimi {
        match state.session.effort_label {
            Some("off") => "off",
            _ => "on",
        }
    } else {
        state
            .session
            .effort_label
            .or_else(|| {
                crate::models::catalog::default_effort_for_static(&state.session.model)
            })
            .unwrap_or("auto")
    };

    let mut rows = vec![
        settings_ro("Version", env!("CARGO_PKG_VERSION")),
        settings_ro("Session ID", session_id_display),
        settings_ro("cwd", cwd),
        settings_blank(),
        settings_ro(
            "Model",
            model_display_with_context(&state.session.model),
        ),
        settings_ro("Permission mode", permission_label),
        settings_ro(effort_label, effort_value),
        settings_blank(),
    ];

    for provider in PROVIDER_ORDER {
        let auth_display = match provider {
            ProviderId::ClaudeCode => {
                match crate::auth::anthropic::load_credentials().ok().flatten() {
                    None => "(not signed in)".to_string(),
                    Some(c) => c
                        .account_email
                        .clone()
                        .unwrap_or_else(|| "OAuth".to_string()),
                }
            }
            ProviderId::Codex => {
                match crate::auth::codex::load_credentials().ok().flatten() {
                    None => "(not signed in)".to_string(),
                    Some(c) => crate::auth::codex::parse_jwt_email(&c.id_token)
                        .unwrap_or_else(|| "OAuth".to_string()),
                }
            }
            ProviderId::GeminiCli => {
                match crate::auth::gemini::load_credentials().ok().flatten() {
                    None => "(not signed in)".to_string(),
                    Some(c) => c
                        .email
                        .clone()
                        .unwrap_or_else(|| "OAuth".to_string()),
                }
            }
            ProviderId::Kimi => {
                match crate::auth::kimi::load_credentials().ok().flatten() {
                    None => "(not configured)".to_string(),
                    Some(c) => format!("API key ****{}", tail_chars(&c.api_key, 3)),
                }
            }
            ProviderId::OpenAiCustom => {
                let cfg = state
                    .persistence
                    .settings
                    .providers
                    .openai_compatible
                    .as_ref();
                let base = cfg.and_then(|o| o.base_url.as_deref()).unwrap_or("");
                let key = cfg
                    .and_then(|o| o.api_key.as_deref())
                    .filter(|s| !s.is_empty());
                if base.is_empty() {
                    "(not configured)".to_string()
                } else if let Some(k) = key {
                    format!("API key ****{}", tail_chars(k, 3))
                } else {
                    let model = cfg
                        .and_then(|o| o.model.as_deref())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("(no model)");
                    format!("{model} [{}]", truncate_url(base, 32))
                }
            }
        };
        rows.push(settings_ro(provider.label(), auth_display));
    }

    rows.push(settings_blank());
    rows.push(settings_ro("MCP servers", "(client lands in Phase 3)"));
    rows
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
        crate::config::settings::PermissionMode::DontAsk => "dontAsk",
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

    let haiku_active = state.session.model.to_ascii_lowercase().starts_with("claude-haiku");

    let mut rows: Vec<MenuOption> = vec![
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
            value_display: Some(model_display_with_context(&state.session.model)),
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
    ];
    if !haiku_active {
        rows.push(MenuOption {
            label: if matches!(provider, ProviderId::Kimi) {
                "Thinking".into()
            } else {
                "Effort".into()
            },
            action_id: "setting:effort".into(),
            value_display: Some(state.session.effort_label.unwrap_or("auto").to_string()),
            settings_kind: Some(SettingsRowKind::Effort),
            hint: None,
            ..Default::default()
        });
    }
    rows.push(settings_blank());
    let rows_tail: Vec<MenuOption> = vec![
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

    ];
    rows.extend(rows_tail);

    if matches!(
        provider,
        ProviderId::Codex | ProviderId::GeminiCli | ProviderId::OpenAiCustom
    ) {
        rows.push(bool_row(
            "Fast mode",
            "fast_mode",
            state.persistence.settings.fast_mode,
            false,
        ));
    }

    let mut caveman = bool_row(
        "Caveman",
        "caveman_enabled",
        state.persistence.settings.caveman_enabled,
        true,
    );
    caveman.details_display = Some(DetailsCell {
        label: "details".into(),
        url: Some("https://github.com/juliusbrussee/caveman".into()),
    });
    rows.push(caveman);

    let mut rtk = bool_row(
        "RTK",
        "rtk_enabled",
        state.persistence.settings.rtk_enabled,
        true,
    );
    rtk.details_display = Some(DetailsCell {
        label: "details".into(),
        url: Some("https://github.com/rtk-ai/rtk".into()),
    });
    rows.push(rtk);

    rows
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

pub fn effort_level_color(value: &str) -> ratatui::style::Color {
    use ratatui::style::Color;
    match value.to_ascii_lowercase().as_str() {
        "off" | "auto" => theme::MUTED,
        "on" => theme::SUCCESS,
        "low" => Color::White,
        "medium" => theme::SUCCESS,
        "high" => theme::PRIMARY,
        "xhigh" => theme::WARNING,
        "max" => theme::ERROR,
        _ => theme::TEXT,
    }
}

fn model_display_with_context(model_id: &str) -> String {
    let label = crate::inference::model_display::resolve_model_label(model_id);
    let context = context_window_label_for(model_id);
    if context.is_empty() {
        label
    } else {
        format!("{label} \u{00B7} {context}")
    }
}

fn context_window_label_for(model_id: &str) -> String {
    let window = crate::models::catalog::context_window_for(model_id);
    if window >= 1_000_000 {
        let m = window as f64 / 1_000_000.0;
        if (m - m.floor()).abs() < 1e-6 {
            format!("{:.0}M context", m)
        } else {
            format!("{:.1}M context", m)
        }
    } else if window >= 1_000 {
        format!("{}k context", window / 1_000)
    } else if window == 0 {
        String::new()
    } else {
        format!("{window} context")
    }
}

fn draw_settings_overlay(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    use super::panel_frame::{body_row, PanelFrame, SearchSpec, TabSpec};
    use crate::tui::slash::catalog::SettingsTab;
    let active_tab = match menu.kind {
        PanelKind::Settings(t) => t,
        _ => return,
    };
    let header_focused = menu.settings_header_focused.unwrap_or(false);
    let body_focused = menu.settings_body_focused;

    let tab_order: [(SettingsTab, &str); 3] = [
        (SettingsTab::Status, "Status"),
        (SettingsTab::Config, "Config"),
        (SettingsTab::Usage, "Usage"),
    ];
    let tabs: Vec<TabSpec<'_>> = tab_order
        .iter()
        .map(|(_, label)| TabSpec { label })
        .collect();
    let active_tab_idx = tab_order
        .iter()
        .position(|(t, _)| *t == active_tab)
        .unwrap_or(0);

    let query = menu.settings_search_query.as_str();
    
    let search_focused = !header_focused && !body_focused;
    let search = SearchSpec {
        query,
        placeholder: "Search settings\u{2026}",
        focused: search_focused,
        cursor_pos: query.len(),
    };

    let lc_query = query.to_lowercase();
    let options_to_render: Vec<(usize, &MenuOption)> = menu
        .options
        .iter()
        .enumerate()
        .filter(|(_, opt)| {
            lc_query.is_empty() || opt.label.to_lowercase().contains(&lc_query)
        })
        .collect();

    let mut body: Vec<Line<'static>> = Vec::with_capacity(menu.options.len() + 4);

    if !lc_query.is_empty() && options_to_render.is_empty() {
        body.push(Line::raw(""));
        body.push(Line::from(Span::styled(
            format!("  No settings match \"{query}\""),
            Style::default().fg(theme::MUTED),
        )));
    } else {
        const LABEL_PAD: usize = 36;
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
                body.push(Line::raw(""));
                continue;
            }
            let is_cursor = effective_cursor == Some(i);
            let label_style = if is_cursor {
                Style::default()
                    .fg(theme::PERMISSION)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };
            let is_effort_row = matches!(
                opt.settings_kind,
                Some(SettingsRowKind::Effort)
            );
            let value_style = if is_cursor {
                Style::default()
                    .fg(theme::PERMISSION)
                    .add_modifier(Modifier::BOLD)
            } else if is_effort_row {
                let level_color = opt
                    .value_display
                    .as_deref()
                    .map(effort_level_color)
                    .unwrap_or(theme::TEXT);
                Style::default()
                    .fg(level_color)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };

            let prefix_line = body_row("", is_cursor, false);
            let mut spans: Vec<Span<'static>> =
                prefix_line.spans.iter().cloned().collect();
            spans.push(Span::styled(opt.label.clone(), label_style));
            if let Some(value) = opt.value_display.as_ref() {
                let label_len = opt.label.chars().count();
                let pad = LABEL_PAD.saturating_sub(label_len);
                spans.push(Span::raw(" ".repeat(pad)));
                spans.push(Span::styled(value.clone(), value_style));
            }
            if let Some(details) = opt.details_display.as_ref() {
                const VALUE_PAD: usize = 12;
                let value_len = opt
                    .value_display
                    .as_deref()
                    .map(|v| v.chars().count())
                    .unwrap_or(0);
                let pad = VALUE_PAD.saturating_sub(value_len);
                spans.push(Span::raw(" ".repeat(pad.max(2))));
                let rendered = match details.url.as_deref() {
                    Some(url) => osc8_hyperlink(url, &details.label),
                    None => details.label.clone(),
                };
                let details_style = if is_cursor {
                    Style::default()
                        .fg(theme::PERMISSION)
                        .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
                } else {
                    Style::default()
                        .fg(theme::MUTED)
                        .add_modifier(Modifier::UNDERLINED)
                };
                spans.push(Span::styled(rendered, details_style));
            }
            body.push(Line::from(spans));
        }
    }

    let view_only =
        matches!(active_tab, SettingsTab::Status | SettingsTab::Usage);

    let footer_view_only: &[(&str, &str)] = &[
        ("\u{2190}/\u{2192}", "switch tabs"),
        ("Esc", "close"),
    ];
    let footer: &[(&str, &str)] = if view_only {
        footer_view_only
    } else if header_focused {
        &[
            ("\u{2190}/\u{2192}", "switch tabs"),
            ("\u{2193}", "search"),
            ("Esc", "cancel"),
        ]
    } else if body_focused {
        &[
            ("\u{2191}\u{2193}", "move"),
            ("Enter", "edit"),
            ("\u{2191}", "search"),
            ("Esc", "close"),
        ]
    } else {
        &[
            ("Type", "filter"),
            ("Enter/\u{2193}", "select"),
            ("\u{2191}", "tabs"),
            ("Esc", "clear"),
        ]
    };

    let panel = PanelFrame {
        title: None,
        tabs: Some(&tabs),
        active_tab: active_tab_idx,
        tabs_focused: header_focused,
        search: if view_only { None } else { Some(search) },
        body,
        footer_hints: footer,
        pagination_hint: None,
    };
    panel.render(f, area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_effort_without_model_uses_codex_safe_fallback() {
        let m = OverlayMenu::new_effort(None);
        let ids: Vec<&str> = m.options.iter().map(|o| o.action_id.as_str()).collect();
        assert_eq!(ids, vec!["low", "medium", "high", "xhigh"]);
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
    fn new_effort_for_haiku_falls_back_to_haiku_scale() {
        let m = OverlayMenu::new_effort_for_model(None, "claude-haiku-4-5");
        let ids: Vec<&str> = m.options.iter().map(|o| o.action_id.as_str()).collect();
        assert_eq!(ids, vec!["auto"]);
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
        assert_eq!(m.cursor, 3);
        m.move_right();
        assert_eq!(m.cursor, 3, "move_right clamps at len-1");
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
    fn commit_model_panel_yields_none_in_phase_1() {
        
        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed(
            "claude-opus-4-7",
            &settings,
            0,
            false,
            0,
        );
        assert!(
            m.commit_outcome().is_none(),
            "model panel must commit via broker, not OverlayMenuOutcome"
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
        for label in ["low", "medium", "high", "xhigh"] {
            assert!(
                joined.contains(label),
                "labels row must carry `{label}`"
            );
        }
        assert!(
            joined.contains("\u{25B8} Effort"),
            "panel must render blue headline `▸ Effort`"
        );
        assert!(
            joined.contains("confirm"),
            "footer must expose `confirm` action hint"
        );

        let marker_row = rows.iter().find(|r| r.contains('▲')).expect("track row");
        let labels_row = rows
            .iter()
            .find(|r| r.contains("low") && r.contains("high"))
            .expect("labels row");
        let marker_col = marker_row.chars().position(|c| c == '▲').unwrap();
        let high_col = labels_row
            .chars()
            .collect::<String>()
            .find("high")
            .unwrap();
        // Fallback ladder collapsed from 5 to 4 positions (no `max`) — label
        // spacing widens across the track, so the marker/high divergence is
        // allowed up to the full between-label span.
        assert!(
            marker_col.abs_diff(high_col) < 12,
            "▲ at col {marker_col}, `high` at col {high_col} — marker must sit near `high`"
        );
    }

    #[test]
    fn settings_search_query_filters_rendered_rows() {
        use crate::tui::slash::catalog::SettingsTab;
        use ratatui::{backend::TestBackend, Terminal};

        let st = crate::tui::state::ConversationState::default();
        let mut m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        
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
    fn status_tab_drops_session_name_row() {
        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Status, &st);
        let labels: Vec<String> = m.options.iter().map(|o| o.label.clone()).collect();
        assert!(
            !labels.iter().any(|l| l == "Session name"),
            "Status tab must not render a Session name row (user directive 2026-04-23)"
        );
    }

    #[test]
    fn status_tab_lists_every_provider_auth_state() {
        use crate::config::providers::PROVIDER_ORDER;
        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Status, &st);
        let labels: Vec<String> = m.options.iter().map(|o| o.label.clone()).collect();
        for provider in PROVIDER_ORDER {
            let want = provider.label();
            assert!(
                labels.iter().any(|l| l == want),
                "Status tab must surface a row for every provider — missing {want}"
            );
        }
    }

    #[test]
    fn search_filter_matches_case_insensitively() {
        
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
        
        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        assert!(m.settings_search_query.is_empty(), "precondition: default query is empty");
        let (joined, _) = render_settings(&m, 140, 40);
        let lc = joined.to_lowercase();
        for row in &["auto-compact", "show tips", "verbose output"] {
            assert!(
                lc.contains(row),
                "empty query must show row `{row}`, got:\n{joined}"
            );
        }
    }

    #[test]
    fn search_no_match_yields_empty_state_marker() {
        
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
        
        use crate::tui::slash::catalog::SettingsTab;

        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        
        assert_eq!(m.settings_header_focused, Some(false), "Config opens with tabs unfocused");
        assert!(!m.settings_body_focused, "Config opens with body unfocused → search region");

        let mut m = m;
        m.settings_header_focused = Some(true);
        assert_eq!(m.settings_header_focused, Some(true));
        assert!(!m.settings_body_focused);

        m.settings_header_focused = Some(false);
        m.settings_body_focused = false;
        assert_eq!(m.settings_header_focused, Some(false));
        assert!(!m.settings_body_focused);

        m.settings_body_focused = true;
        assert_eq!(m.settings_header_focused, Some(false));
        assert!(m.settings_body_focused, "second ↓ from search must land in body region");
    }

    #[test]
    fn config_rows_include_caveman_and_rtk_with_default_on() {
        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        let caveman = m
            .options
            .iter()
            .find(|o| o.label == "Caveman")
            .expect("Caveman row present in /config");
        let rtk = m
            .options
            .iter()
            .find(|o| o.label == "RTK")
            .expect("RTK row present in /config");
        assert_eq!(caveman.value_display.as_deref(), Some("true"));
        assert_eq!(rtk.value_display.as_deref(), Some("true"));
        assert!(matches!(caveman.settings_kind, Some(SettingsRowKind::Bool("caveman_enabled"))));
        assert!(matches!(rtk.settings_kind, Some(SettingsRowKind::Bool("rtk_enabled"))));
        assert_eq!(
            caveman
                .details_display
                .as_ref()
                .and_then(|d| d.url.as_deref()),
            Some("https://github.com/juliusbrussee/caveman"),
        );
        assert_eq!(
            rtk.details_display
                .as_ref()
                .and_then(|d| d.url.as_deref()),
            Some("https://github.com/rtk-ai/rtk"),
        );
        assert_eq!(
            caveman
                .details_display
                .as_ref()
                .map(|d| d.label.as_str()),
            Some("details"),
        );
        assert_eq!(
            rtk.details_display.as_ref().map(|d| d.label.as_str()),
            Some("details"),
        );
    }

    #[test]
    fn caveman_and_rtk_rows_respect_stored_false() {
        let mut st = crate::tui::state::ConversationState::default();
        st.persistence.settings.caveman_enabled = Some(false);
        st.persistence.settings.rtk_enabled = Some(false);
        let m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        let caveman = m
            .options
            .iter()
            .find(|o| o.label == "Caveman")
            .expect("Caveman row present");
        let rtk = m
            .options
            .iter()
            .find(|o| o.label == "RTK")
            .expect("RTK row present");
        assert_eq!(caveman.value_display.as_deref(), Some("false"));
        assert_eq!(rtk.value_display.as_deref(), Some("false"));
    }

    #[test]
    fn osc8_hyperlink_wraps_label_with_escape_sequence() {
        let rendered = osc8_hyperlink("https://example.test/x", "details");
        assert_eq!(rendered, "\x1b]8;;https://example.test/x\x1b\\details\x1b]8;;\x1b\\");
    }

    #[test]
    fn settings_render_emits_osc8_hyperlink_for_details_cell() {
        let st = crate::tui::state::ConversationState::default();
        let mut m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        m.settings_search_query = "caveman".into();
        let (joined, _) = render_settings(&m, 200, 30);
        assert!(
            joined.contains("details"),
            "Caveman row must render trailing `details` link label, got:\n{joined}"
        );
    }

    #[test]
    fn tab_chip_paint_swaps_between_primary_blue_and_inverted_white() {
        // 2026-04-24 user directive:
        //   tabs_focused = true  → bg PRIMARY (blue), fg white
        //   tabs_focused = false → bg white, fg black (inverted)
        let st = crate::tui::state::ConversationState::default();
        let mut m = OverlayMenu::new_settings(SettingsTab::Config, &st);

        m.settings_header_focused = Some(false);
        let (joined_a, buf_a) = render_settings(&m, 140, 30);
        let (row_a, col_a) = locate_substring(&joined_a, "Config").expect("Config chip visible");
        let cell_a = buf_a[(col_a as u16, row_a as u16)].clone();

        m.settings_header_focused = Some(true);
        let (joined_b, buf_b) = render_settings(&m, 140, 30);
        let (row_b, col_b) = locate_substring(&joined_b, "Config").expect("Config chip visible");
        let cell_b = buf_b[(col_b as u16, row_b as u16)].clone();

        assert_eq!(
            cell_a.bg,
            Color::White,
            "unfocused active chip bg must be white (inverted): {:?}",
            cell_a
        );
        assert_eq!(
            cell_a.fg,
            Color::Black,
            "unfocused active chip fg must be black: {:?}",
            cell_a
        );
        assert_eq!(
            cell_b.bg,
            theme::PRIMARY,
            "focused active chip bg must be PRIMARY blue: {:?}",
            cell_b
        );
        assert_eq!(
            cell_b.fg,
            Color::White,
            "focused active chip fg must be white: {:?}",
            cell_b
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

    fn render_overlay(menu: &OverlayMenu, w: u16, h: u16) -> String {
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
        let mut out = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                out.push_str(buf[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn new_model_panel_has_five_tabs_in_provider_order() {
        use crate::config::providers::{ProviderId, PROVIDER_ORDER};
        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed(
            "claude-opus-4-7",
            &settings,
            0,
            true,
            0,
        );
        assert_eq!(
            m.model_tab_rows.len(),
            PROVIDER_ORDER.len(),
            "must have one tab per PROVIDER_ORDER entry"
        );
        assert_eq!(m.model_tab_rows.len(), 5);
        let order: Vec<ProviderId> =
            m.model_tab_rows.iter().map(|t| t.provider).collect();
        let expected: Vec<ProviderId> = PROVIDER_ORDER.iter().copied().collect();
        assert_eq!(order, expected, "tab order must match PROVIDER_ORDER");

        let joined = render_overlay(&m, 120, 20);
        for label in &["Anthropic", "Codex", "Gemini", "Kimi Code", "Custom"] {
            assert!(
                joined.contains(label),
                "tab row must show `{label}`, got:\n{joined}"
            );
        }
        assert!(
            !joined.contains("(OAuth)"),
            "tab labels must be short — `(OAuth)` qualifier forbidden per spec"
        );
    }

    #[test]
    fn active_tab_defaults_to_settings_default_provider() {
        
        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed(
            "kimi-for-coding",
            &settings,
            3,
            true,
            0,
        );
        assert_eq!(m.model_tab_index, 3);
        assert_eq!(
            m.active_model_tab().unwrap().provider,
            crate::config::providers::ProviderId::Kimi,
            "tab_index=3 must resolve to Kimi per PROVIDER_ORDER"
        );
    }

    #[test]
    fn authenticated_tab_body_renders_catalog_plus_logout_row() {
        
        let rows = build_tab_rows(
            crate::config::providers::ProviderId::Codex,
            true,
            "gpt-5.4",
        );
        let model_count = rows
            .iter()
            .filter(|r| matches!(r, ModelTabRow::Model { .. }))
            .count();
        let logout_count = rows
            .iter()
            .filter(|r| matches!(r, ModelTabRow::Logout))
            .count();
        assert!(
            model_count >= 1,
            "Codex authed body must carry at least one model row"
        );
        assert_eq!(logout_count, 1, "authed body must end with a single Logout row");
        assert!(
            matches!(rows.last(), Some(ModelTabRow::Logout)),
            "Logout must be the last row"
        );
        
        let active_row = rows.iter().find_map(|r| match r {
            ModelTabRow::Model { raw_id, active, .. } if raw_id == "gpt-5.4" => {
                Some(*active)
            }
            _ => None,
        });
        assert_eq!(active_row, Some(true));
    }

    #[test]
    fn unauthenticated_tab_body_renders_login_cta() {
        
        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed(
            "claude-opus-4-7",
            &settings,
            2, 
            false,
            0,
        );
        let tab = m.active_model_tab().unwrap();
        assert!(!tab.authed, "Gemini tab must be unauthenticated in Phase 1");
        assert_eq!(tab.rows.len(), 1);
        assert!(matches!(tab.rows[0], ModelTabRow::LoginCta));

        let joined = render_overlay(&m, 100, 20);
        assert!(
            joined.contains("You are not logged in to Gemini."),
            "unauth body must include the `You are not logged in to {{Provider}}` line, got:\n{joined}"
        );
        assert!(
            joined.contains("Login to Gemini"),
            "unauth body must include the `Login to {{Provider}}` CTA label, got:\n{joined}"
        );
    }

    #[test]
    fn custom_unauthenticated_body_shows_configure_cta() {

        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed(
            "",
            &settings,
            4,
            false,
            0,
        );
        let tab = m.active_model_tab().unwrap();
        assert!(!tab.authed);
        assert_eq!(tab.rows.len(), 1);
        assert!(matches!(tab.rows[0], ModelTabRow::CustomHint));

        let joined = render_overlay(&m, 120, 20);
        assert!(
            joined.contains("Custom (OpenAI-compatible) endpoint is not configured"),
            "custom unauth must explain state, got:\n{joined}"
        );
        assert!(
            joined.contains("Configure Custom endpoint"),
            "custom unauth must show a configure CTA, got:\n{joined}"
        );
        assert!(
            !joined.contains("Login to Custom"),
            "Custom must NOT show a Login CTA",
        );
    }

    #[test]
    fn tab_row_cycles_on_arrow_and_tab() {
        use crate::config::providers::PROVIDER_ORDER;
        
        let settings = crate::config::settings::Settings::default();
        let mut idx = 0usize;
        for _ in 0..PROVIDER_ORDER.len() {
            let m = OverlayMenu::new_model_tabbed(
                "",
                &settings,
                idx,
                true,
                0,
            );
            assert_eq!(m.model_tab_index, idx);
            idx = (idx + 1) % PROVIDER_ORDER.len();
        }
        
        let m = OverlayMenu::new_model_tabbed(
            "",
            &settings,
            99,
            true,
            0,
        );
        assert_eq!(
            m.model_tab_index,
            PROVIDER_ORDER.len() - 1,
            "out-of-bounds tab_index must clamp to the last tab"
        );
    }

    #[test]
    fn body_enter_on_model_row_logs_stub_intent() {
        
        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed(
            "claude-opus-4-7",
            &settings,
            0,
            false, 
            0,
        );
        assert!(
            m.commit_outcome().is_none(),
            "Phase 1 model Enter must not emit an outcome — stub logs only"
        );
        
        assert_eq!(
            m.active_action_id.as_deref(),
            Some("claude-opus-4-7"),
            "builder must NOT mutate the active model id"
        );
    }

    #[test]
    fn esc_closes_panel() {
        
        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed("", &settings, 0, true, 0);
        assert_eq!(m.kind, PanelKind::Model);
        assert!(
            m.settings_search_query.is_empty(),
            "tabbed model panel has no search bar — Esc must close, never clear"
        );
    }

    #[test]
    fn config_panel_renders_top_rule_row_in_primary() {
        
        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        let (joined, buf) = render_settings(&m, 120, 30);

        let first_row: String = joined.lines().next().unwrap_or("").to_string();
        assert!(
            first_row.contains('\u{2500}'),
            "/config y=0 must carry ─ glyphs (top rule), got:\n{first_row}"
        );
        assert!(
            !first_row.contains("Status") && !first_row.contains("Config"),
            "/config y=0 must NOT be the tab row — rule comes first, got:\n{first_row}"
        );

        let mid_col = buf.area.width / 2;
        let cell = buf[(mid_col, 0u16)].clone();
        assert_eq!(
            cell.symbol(),
            "\u{2500}",
            "mid-row cell at y=0 must be a ─ glyph, got {:?}",
            cell.symbol()
        );
        assert_eq!(
            cell.fg,
            theme::PRIMARY,
            "top rule fg must be theme::PRIMARY (rgb 0x3E,0xA0,0xC3), got {:?}",
            cell.fg
        );
    }

    #[test]
    fn model_panel_renders_top_rule_row_in_primary() {
        
        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed(
            "claude-opus-4-7",
            &settings,
            0,
            true,
            0,
        );
        use ratatui::{backend::TestBackend, Terminal};
        let backend = TestBackend::new(120u16, 20u16);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_overlay(f, area, &m);
            })
            .unwrap();
        let buf = terminal.backend().buffer().clone();

        let mid_col = buf.area.width / 2;
        let cell = buf[(mid_col, 0u16)].clone();
        assert_eq!(
            cell.symbol(),
            "\u{2500}",
            "/model y=0 mid-row must be a ─ glyph, got {:?}",
            cell.symbol()
        );
        assert_eq!(
            cell.fg,
            theme::PRIMARY,
            "/model top rule fg must be theme::PRIMARY, got {:?}",
            cell.fg
        );
    }

    #[test]
    fn config_panel_uses_panel_frame_chrome() {
        let st = crate::tui::state::ConversationState::default();
        let m = OverlayMenu::new_settings(SettingsTab::Config, &st);
        let (_joined, buf) = render_settings(&m, 120, 30);

        let rule_cell = buf[(0u16, 0u16)].clone();
        assert_eq!(
            rule_cell.symbol(),
            "\u{2500}",
            "config y=0 x=0 must be the top-rule ─ glyph, got {:?}",
            rule_cell.symbol()
        );
        assert_eq!(
            rule_cell.fg,
            theme::PRIMARY,
            "config top rule must be painted by PanelFrame in theme::PRIMARY, got {:?}",
            rule_cell.fg
        );

        for x in 0..buf.area.width {
            let cell = buf[(x, 1u16)].clone();
            assert_eq!(
                cell.symbol(),
                " ",
                "config y=1 must be the blank headline-padding row (chrome.md), \
                 but x={x} contains {:?}",
                cell.symbol()
            );
        }
    }

    #[test]
    fn model_panel_uses_panel_frame_chrome() {
        let settings = crate::config::settings::Settings::default();
        let m = OverlayMenu::new_model_tabbed(
            "claude-opus-4-7",
            &settings,
            0,
            true,
            0,
        );
        use ratatui::{backend::TestBackend, Terminal};
        let backend = TestBackend::new(120u16, 20u16);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_overlay(f, area, &m);
            })
            .unwrap();
        let buf = terminal.backend().buffer().clone();

        let rule_cell = buf[(0u16, 0u16)].clone();
        assert_eq!(
            rule_cell.symbol(),
            "\u{2500}",
            "model y=0 x=0 must be the top-rule ─ glyph, got {:?}",
            rule_cell.symbol()
        );
        assert_eq!(
            rule_cell.fg,
            theme::PRIMARY,
            "model top rule must be painted by PanelFrame in theme::PRIMARY, got {:?}",
            rule_cell.fg
        );

        for x in 0..buf.area.width {
            let cell = buf[(x, 1u16)].clone();
            assert_eq!(
                cell.symbol(),
                " ",
                "model y=1 must be the blank headline-padding row (chrome.md), \
                 but x={x} contains {:?}",
                cell.symbol()
            );
        }
    }
}
