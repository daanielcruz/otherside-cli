

use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Clear, Paragraph},
    Frame,
};

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

    pub settings_kind: Option<SettingsRowKind>,
}

#[derive(Debug, Clone)]
pub struct OverlayMenu {
    pub kind: PanelKind,
    pub title: String,
    pub options: Vec<MenuOption>,
    pub cursor: usize,

    pub settings_header_focused: Option<bool>,

    pub effort_indicator: Option<EffortIndicator>,

    pub active_action_id: Option<String>,
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
        }
    }

    pub fn new_model_with_effort(current: &str, current_effort: Option<&str>) -> Self {

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
        let options: Vec<MenuOption> = rows
            .iter()
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
            .collect();
        let cursor = options
            .iter()
            .position(|o| o.action_id == current)
            .unwrap_or(0);

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
        }
    }

    pub fn new_model(current: &str) -> Self {
        Self::new_model_with_effort(current, None)
    }

    pub fn new_effort(current: Option<&str>) -> Self {
        const LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
        let options: Vec<MenuOption> = LEVELS
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
            .and_then(|c| LEVELS.iter().position(|&l| l == c))
            .unwrap_or(2);
        let active_id = current
            .map(str::to_lowercase)
            .filter(|c| LEVELS.iter().any(|l| *l == c.as_str()));
        Self {
            kind: PanelKind::Effort,
            title: "Set effort level".into(),
            options,
            cursor,
            settings_header_focused: None,
            effort_indicator: None,
            active_action_id: active_id,
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
            PanelKind::Model => Some(OverlayMenuOutcome::SetModel {
                model_id: selected.action_id.clone(),
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayMenuOutcome {

    SetEffort { action_id: String, label: String },

    SetPermissionMode { action_id: String },

    SetModel { model_id: String },
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
    vec![
        settings_ro("Version", env!("CARGO_PKG_VERSION")),
        settings_ro("Session name", "(unnamed)"),
        settings_ro("Session ID", "(not persisted)"),
        settings_ro("cwd", cwd),
        settings_ro("Login method", "(none)"),
        settings_ro("Organization", "(n/a)"),
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

        bool_row("Auto-compact", "auto_compact", state.settings.auto_compact, true),
        bool_row("Show tips", "show_tips", state.settings.show_tips, true),

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

    ]
}

fn usage_rows() -> Vec<MenuOption> {
    vec![
        settings_ro("Current session", "(tracker pending)"),
        settings_ro("Current week", "(tracker pending)"),
        settings_blank(),
        settings_ro("Status", "Usage telemetry lands with 010-usage-tracking"),
    ]
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

            Style::default()
                .bg(theme::PERMISSION)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD)
        } else if is_current {

            Style::default()
                .add_modifier(Modifier::REVERSED)
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
    let mid_pad = inner_width.saturating_sub(" ⌕ Search settings…".len() + 2);
    let mid = format!(
        "  │ ⌕ Search settings…{} │",
        " ".repeat(mid_pad)
    );
    let bot = format!("  ╰{}╯", "─".repeat(inner_width.saturating_sub(2)));
    let permission_style = Style::default().fg(theme::PERMISSION);
    lines.push(Line::from(Span::styled(top, permission_style)));
    lines.push(Line::from(Span::styled(mid, permission_style)));
    lines.push(Line::from(Span::styled(bot, permission_style)));
    lines.push(Line::raw(""));

    const LABEL_PAD: usize = 43;
    for (i, opt) in menu.options.iter().enumerate() {

        if opt.label.is_empty() && opt.value_display.is_none() {
            lines.push(Line::raw(""));
            continue;
        }
        let is_cursor = i == menu.cursor && !header_focused;
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
        "  ← → or Tab to switch tabs · ↓ to settings · Esc to cancel"
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
    fn new_model_has_three_rows_per_upstream() {

        let m = OverlayMenu::new_model_with_effort("claude-opus-4-7[1m]", Some("xhigh"));
        assert_eq!(
            m.options.len(),
            3,
            "upstream shows 3 rows per /tmp/parity-20260420-tmux/04-model-panel/upstream-open.txt lines 32-34"
        );
        assert_eq!(m.options[0].label, "Default (recommended)");

        assert!(
            m.options[0].action_id == "claude-opus-4-7"
                || m.options[0].action_id == "claude-opus-4-7[1m]",
            "opus row action_id must be one of the two variants, got {}",
            m.options[0].action_id
        );
        assert!(
            m.options[0]
                .hint
                .as_deref()
                .map(|h| h.starts_with("Opus 4.7"))
                .unwrap_or(false)
        );
        assert_eq!(m.options[1].label, "Sonnet");
        assert_eq!(m.options[1].action_id, "claude-sonnet-4-6");
        assert_eq!(
            m.options[1].hint.as_deref(),
            Some("Sonnet 4.6 · Best for everyday tasks")
        );
        assert_eq!(m.options[2].label, "Haiku");
        assert_eq!(m.options[2].action_id, "claude-haiku-4-5");
        assert_eq!(
            m.options[2].hint.as_deref(),
            Some("Haiku 4.5 · Fastest for quick answers")
        );

        assert_eq!(m.cursor, 0);
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
    fn new_model_cursor_defaults_to_zero_for_unknown() {

        let m = OverlayMenu::new_model("some-unknown-alias");
        assert_eq!(m.cursor, 0);
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
        m.cursor = 1;
        match m.commit_outcome().expect("outcome") {
            OverlayMenuOutcome::SetModel { model_id } => {
                assert_eq!(model_id, "claude-sonnet-4-6");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
        let mut m = OverlayMenu::new_model("claude-opus-4-7[1m]");
        m.cursor = 2;
        match m.commit_outcome().expect("outcome") {
            OverlayMenuOutcome::SetModel { model_id } => {
                assert_eq!(model_id, "claude-haiku-4-5");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
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
}
