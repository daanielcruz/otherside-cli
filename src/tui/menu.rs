//! Overlay-menu primitive — the reusable widget that powers the 13
//! Panel slashes (`/model`, `/effort`, `/permissions`, `/help`, …).
//!
//! # Shape
//!
//! Upstream mounts an ink widget in the prompt slot while a menu is
//! active, captures focus until `onDone` fires, then returns a result
//! string that gets appended to the transcript. We mirror that shape
//! with:
//!
//! - [`OverlayMenu`] — modal state: title, option list, cursor, result.
//! - [`OverlayMenuOutcome`] — what the event loop does after a commit:
//!   `SetEffort` flips thinking config, `SetModel` switches model, …
//! - [`draw_overlay`] — paints the widget above the prompt bar.
//!
//! # Event loop contract
//!
//! While `ConversationState::active_menu` is `Some`:
//!
//! | Key        | Action                                |
//! |------------|---------------------------------------|
//! | `↑` / `↓`  | Move cursor (wraps)                   |
//! | `Home`     | Jump to first option                  |
//! | `End`      | Jump to last option                   |
//! | `Enter`    | Commit selection → `OverlayMenuOutcome` |
//! | `Esc`      | Cancel, leaves state untouched        |
//! | any other  | Swallowed — overlay is modal          |
//!
//! Other UI surfaces (input, autocomplete, permission cycle, streaming
//! keys) are suppressed until the menu resolves.

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

/// Editable-row kind for Settings panel options. Non-Settings
/// panels set this to `None` and fall back to the legacy
/// "pick a row and Enter to commit" flow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsRowKind {
    /// Provider selector — cycles through `ProviderId::PROVIDER_ORDER`
    /// with side effect: switching provider sets `state.session.model` to the
    /// provider's default alias (openspec 009).
    Provider,
    /// Model cycle — values depend on the active provider. `action_id`
    /// encodes a `setting:model` marker; the dispatcher walks the
    /// provider's model list.
    Model,
    /// Permission mode cycle: Default / AcceptEdits / Plan / Yolo.
    PermissionMode,
    /// Effort-level cycle: auto / low / medium / high / xhigh / max.
    Effort,
    /// Boolean toggle keyed by `action_id` suffix (e.g.
    /// `setting:bool:auto_compact`). The dispatcher reads the suffix
    /// to route the flip to the right `settings.*` field.
    Bool(&'static str),
    /// Read-only informational row (no interaction).
    ReadOnly,
}

/// One selectable row inside an [`OverlayMenu`].
#[derive(Debug, Clone, Default)]
pub struct MenuOption {
    /// Display text rendered in the option row.
    pub label: String,
    /// Opaque action id — interpreted by the per-variant commit-to-
    /// outcome mapper. For `/effort` this is the thinking level name.
    pub action_id: String,
    /// Optional secondary line (dim, 1 row). `None` suppresses the hint.
    pub hint: Option<String>,
    /// Two-column value string when the row is a Settings-panel row
    /// (renders right-aligned next to the label). `None` for plain
    /// info/menu rows — the legacy single-column shape.
    pub value_display: Option<String>,
    /// Settings-panel edit kind — `Some(_)` marks the row as
    /// interactive under openspec 009. `None` for every non-Settings
    /// panel and for Settings rows that are purely informational.
    pub settings_kind: Option<SettingsRowKind>,
}

/// Modal overlay state. `active_menu` on `ConversationState` wraps this
/// in `Option` so `Some` ≡ "a menu is capturing focus".
#[derive(Debug, Clone)]
pub struct OverlayMenu {
    pub kind: PanelKind,
    pub title: String,
    pub options: Vec<MenuOption>,
    pub cursor: usize,
    /// Only meaningful when `kind == PanelKind::Settings(_)`. Mirrors
    /// upstream `Settings.tsx:115` — `/config` lands with list focus
    /// (false), `/status` and `/usage` with tab-row focus (true).
    /// `None` for non-Settings panels.
    pub settings_header_focused: Option<bool>,
    /// Only meaningful when `kind == PanelKind::Model`. Captures the
    /// session's current effort level at overlay mount so the picker
    /// can render the inline `◉ {Level} effort (default) ← → to adjust`
    /// indicator that upstream shows between the option list and the
    /// footer (014 evidence: `/tmp/parity-20260420-tmux/04-model-panel/upstream-open.txt` line 36).
    /// `None` on every non-Model panel and when effort is unset.
    pub effort_indicator: Option<EffortIndicator>,
    /// The `action_id` of the currently-active row — the one that
    /// paints green + ✔ in the render. Single source of truth at
    /// overlay construction time: caller passes `st.session.model` (or
    /// `st.session.permission_mode`, etc.) so the checkmark can never drift
    /// from session state. `None` on panels where "active" is not
    /// applicable (e.g. `/help` info overlays).
    pub active_action_id: Option<String>,
}

/// Snapshot of the effort level shown beneath the `/model` picker.
/// Held by value so the renderer doesn't need to cross-read
/// `ConversationState` at paint time.
#[derive(Debug, Clone)]
pub struct EffortIndicator {
    /// Canonical level string — e.g. `"high"`, `"xhigh"`. Rendered
    /// capitalized in the indicator line.
    pub level: String,
    /// True when `level` equals the model's default (appends the
    /// `(default)` suffix upstream renders).
    pub is_default: bool,
}

impl OverlayMenu {
    /// Build a generic information overlay — a single
    /// `Acknowledge` row that dismisses the menu on Enter. Multi-row
    /// hint text supplied via `hints` renders above the ack row.
    /// Used by `/status`, `/config`, `/help`, `/hooks`, `/diff`,
    /// `/resume`, `/rewind`, `/skills`, `/agents`, `/mcp` where the
    /// upstream flow is "show something, wait for dismissal".
    pub fn new_info(kind: PanelKind, title: String, hints: Vec<String>) -> Self {
        let options = vec![MenuOption {
            label: "Close".into(),
            action_id: "__close__".into(),
            hint: Some("press Enter or Esc to dismiss".into()),
            ..Default::default()
        }];
        // Hints ride as prefix-lines via `MenuOption.hint` on a
        // virtual header option — cheapest way to reuse the renderer.
        // Each hint becomes a dimmed row above the `Close` action.
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
        // Cursor starts on the first row with a non-empty label so
        // the user sees it settle on useful content instead of a
        // blank separator. Info rows are navigable (C71).
        let cursor = options_with_hints
            .iter()
            .position(|o| !o.label.is_empty())
            .unwrap_or(0);
        // Settings panel (`/status`, `/config`, `/usage`) gets an
        // initial header-focus flag per upstream `Settings.tsx:115`:
        // Config lands in the list (false), Status and Usage land in
        // the tab row (true).
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

    /// Build the unified Settings panel (`/status`, `/config`, `/usage`)
    /// landing on `default_tab`. Rows are per-tab; Config carries
    /// interactive settings (009), Status/Usage carry read-only info.
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

    /// Build the `/permissions` picker — select one of the four
    /// permission modes. Current mode is preselected.
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

    /// Build the `/model` picker — 3-row shape mirroring upstream v2.1.114's
    /// Max/Team-Premium model picker (R-92 evidence: `/tmp/parity-20260420-tmux/04-model-panel/upstream-open.txt`
    /// lines 32-34 + `components/ModelPicker.tsx` + `utils/model/modelOptions.ts`).
    ///
    /// - `Default (recommended)` → resolves to `claude-opus-4-7[1m]`
    ///   (`ProviderId::ClaudeCode.default_model()`). Carrying the literal
    ///   model id in `action_id` keeps `apply_model_outcome` unchanged.
    /// - `Sonnet` → `claude-sonnet-4-6`.
    /// - `Haiku` → `claude-haiku-4-5`.
    ///
    /// `effort_indicator` ties the inline `◉ {Level} effort (default) ← → to adjust`
    /// line upstream renders below the list. `current_effort` is the
    /// session's active level ("high" / "xhigh" / …); pass `None` to
    /// suppress the indicator (e.g. unit tests).
    pub fn new_model_with_effort(current: &str, current_effort: Option<&str>) -> Self {
        // Opus row is mutually exclusive: 1M variant when the account
        // has that entitlement, plain 4.7 otherwise. Both never coexist
        // in the picker.
        let has_1m = crate::models::defaults::SubscriptionTier::from_subscription_type(
            crate::auth::anthropic::load_credentials()
                .ok()
                .flatten()
                .and_then(|c| c.subscription_type)
                .as_deref(),
        )
        .has_opus_1m();
        // Hints come from the catalog's `display_hint` column — the
        // short row labels stay UX copy here. Row 0's id flips with
        // the tier; hint flips with the id via catalog lookup.
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
        // Default effort for Opus models is xhigh per upstream
        // `utils/effort.ts::getDefaultEffortLevel`. We don't gate per
        // model here — the `(default)` suffix flips when level matches.
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
            // Active row = the one matching the session's current model.
            // Single source of truth: caller passes `st.session.model`, so the
            // ✔/green checkmark cannot drift from statusline state.
            active_action_id: Some(current.to_string()),
        }
    }

    /// Legacy constructor kept for callers that do not yet surface the
    /// current effort level. Delegates to `new_model_with_effort` with
    /// `current_effort = None`.
    pub fn new_model(current: &str) -> Self {
        Self::new_model_with_effort(current, None)
    }

    /// Build the `/effort` slider — 5 positions mirroring upstream's
    /// `SLIDER_LEVELS` in `commands/effort/effort.tsx:9-15`
    /// (`low, medium, high, xhigh, max`). The picker does NOT expose
    /// `auto` — that value is reachable only via the `/effort auto`
    /// command arg, which routes through `executeEffort` →
    /// `unsetEffortLevel`. R-92 evidence:
    /// `/tmp/parity-20260420-tmux/07-effort-panel/upstream-open.txt`
    /// lines 33-38.
    ///
    /// Cursor preselects the matching position (case-insensitive).
    /// When `current` is `None`, `"auto"`, or unrecognized, falls back
    /// to position 2 (`high`) — the reasonable midpoint display; the
    /// user can press ← / → before Enter to pick another level.
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

    /// Move the cursor up; wraps to the last row when at the top.
    /// Skips rows with empty labels (visual separators) so the cursor
    /// never lands on a blank line. `__line__` info rows ARE navigable
    /// — users reported info panels felt frozen without cursor walk.
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

    /// Move the cursor down; wraps to the first row when at the bottom.
    /// Blank-label rows (visual separators) skipped.
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

    /// Move the cursor one step left. Clamped at 0 — the effort
    /// slider does not wrap (upstream's `SLIDER_LEVELS` stops at
    /// `low` on the left). Intended for `/effort`; other panels use
    /// `move_up` / `move_down` for vertical navigation.
    pub fn move_left(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
        }
    }

    /// Move the cursor one step right. Clamped at `len - 1`.
    /// Companion to `move_left` for horizontal sliders.
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

    /// The option Enter would commit. None when the menu is empty —
    /// defensive, real menus always populate at least one row.
    pub fn selected(&self) -> Option<&MenuOption> {
        self.options.get(self.cursor)
    }

    /// Translate the currently-selected option into an outcome the
    /// event loop dispatches. Returning `None` means the menu closed
    /// without a side effect (help / status variants do this).
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

/// What the event loop does after the user hits Enter inside the
/// overlay. One variant per outcome class; per-PanelKind commits map
/// into these during [`OverlayMenu::commit_outcome`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayMenuOutcome {
    /// `/effort` — flip the session's thinking level. `action_id` is
    /// the lowercase canonical name accepted by
    /// [`crate::thinking::ThinkingLevel::from_str`] plus `"auto"`.
    SetEffort { action_id: String, label: String },
    /// `/permissions` — swap the active permission mode.
    /// `action_id` is one of `default`, `acceptEdits`, `plan`, `yolo`.
    SetPermissionMode { action_id: String },
    /// `/model` — switch model for subsequent turns.
    SetModel { model_id: String },
}

/// Active modal permission prompt — owns the one-shot reply channel
/// so the agent task unblocks when the user resolves the overlay.
/// Distinct from [`OverlayMenu`] because the `Sender` isn't Clone +
/// the render path shows tool-specific context (name, args preview)
/// above the three choices.
pub struct PendingPermissionPrompt {
    pub tool_name: String,
    pub args_preview: String,
    /// Rule text surfaced by `permissions::resolve` when the Ask
    /// policy fired via a specific matcher rule (rather than the
    /// default mutating-tool fallthrough). `None` → "manual approval".
    pub rule: Option<String>,
    /// Cursor index across the three choices — `Allow`, `AllowSession`,
    /// `Deny`.
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

/// Fixed choice list for the permission overlay. Index matches the
/// `cursor` field on [`PendingPermissionPrompt`]. Mirrors upstream's
/// three-row "approve this call" dialog.
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

    /// Fire the reply oneshot for the current cursor and consume the
    /// sender so a double-commit can't happen. Called from the event
    /// loop's Enter / Esc handlers (Esc implicitly denies).
    pub fn resolve(&mut self, response: crate::permissions::PermissionResponse) {
        if let Some(tx) = self.reply.take() {
            let _ = tx.send(response); // agent task may have gone away
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

/// Agent-driven text-input prompt (AskUserQuestion). Distinct from
/// [`PendingPermissionPrompt`] because the reply is free-form text
/// rather than a choice index, and the render path embeds a live
/// input line. Fires a `oneshot` with the typed answer on Enter,
/// or an empty string on Esc (the agent treats empty as "declined").
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

/// Paint the AskUserQuestion overlay — question prose, optional hint
/// below, a live input row, and the Enter/Esc footer.
///
/// Rendered borderless-inline so the surface sits flush above the
/// prompt bar the way upstream's ink widgets do. `Clear` is rendered
/// first so retained cells (mascot / prior log content) never bleed.
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

/// Draw the permission overlay. Borderless-inline shape matches
/// upstream's ink mount — title line, tool identity, choices, footer.
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

/// Minimum height the overlay widget needs to render cleanly (title +
/// at least one option row). Layout callers short-circuit to an inline
/// note when the prompt area is smaller than this.
pub const MIN_HEIGHT: u16 = 3;

/// Return the exact row count the overlay will emit. Used by the
/// render path to shrink-wrap the overlay Rect so the surface sits
/// flush above the prompt bar instead of floating halfway up the log.
pub fn overlay_rows(menu: &OverlayMenu) -> u16 {
    // Settings panel uses a distinct shape: tab bar + blank + search
    // box (3 rows) + blank + content + blank + footer. Content rows
    // equal the options whose label is non-empty (Close row counts).
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
    // Effort slider — fixed shape per upstream capture
    // (`/tmp/parity-20260420-tmux/07-effort-panel/upstream-open.txt` lines 32-38):
    // blank + axis-labels + track + position-labels + blank + blank + footer.
    if matches!(menu.kind, PanelKind::Effort) {
        return 7;
    }
    // title + blank + per-option(label + optional hint) + blank + footer
    let mut rows: u16 = 2; // title + blank
    for opt in &menu.options {
        rows = rows.saturating_add(1);
        if opt.action_id != "__line__" && opt.hint.is_some() {
            rows = rows.saturating_add(1);
        }
    }
    // Model panel injects an extra effort-indicator line between the
    // list and the footer.
    if matches!(menu.kind, PanelKind::Model) && menu.effort_indicator.is_some() {
        rows = rows.saturating_add(2); // blank + indicator
    }
    rows = rows.saturating_add(2); // blank + footer
    rows
}

/// Paint the overlay into `area`. Borderless inline shape — title line,
/// option rows, footer hint — mirroring upstream's `local-jsx` mounts.
/// `Clear` is rendered first so retained cells (mascot / log content)
/// never bleed through.
pub fn draw_overlay(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    if area.height == 0 {
        return;
    }
    f.render_widget(Clear, area);

    // Settings panel has its own shape — tab bar + search box +
    // content + footer per upstream `components/Settings/Settings.tsx`
    // + `design-system/Tabs.tsx`. Branch here so non-Settings panels
    // keep the plain bullet-list layout untouched.
    if matches!(menu.kind, PanelKind::Settings(_)) {
        draw_settings_overlay(f, area, menu);
        return;
    }

    // Effort picker renders as a horizontal slider, not a vertical
    // list. Dispatch to its own draw path (014).
    if matches!(menu.kind, PanelKind::Effort) {
        draw_effort_slider(f, area, menu);
        return;
    }

    // Model picker matches upstream's single-line-per-row shape —
    // `N. label [✔]  description` with subtitle and inline effort
    // indicator. Dispatch to dedicated draw path so the generic
    // vertical list below keeps its two-row-per-option layout for
    // other panels.
    if matches!(menu.kind, PanelKind::Model) {
        draw_model_overlay(f, area, menu);
        return;
    }

    let mut lines: Vec<Line<'static>> = Vec::with_capacity(menu.options.len() * 2 + 4);

    // Title line — replaces upstream's bordered title. Bold primary
    // color, two-space left pad for inline rhythm.
    lines.push(Line::from(Span::styled(
        format!("  {}", menu.title),
        Style::default()
            .fg(theme::PRIMARY)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::raw(""));

    for (i, opt) in menu.options.iter().enumerate() {
        // Empty-label rows are visual separators — render a blank
        // line and skip the cursor marker (separators are unreachable
        // by the navigable walk, so `i == menu.cursor` never fires).
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
        // Info rows (`__line__`) stay muted even under cursor so the
        // panel reads as "this is prose you're walking through" not
        // "press Enter here". Action rows read in the normal TEXT
        // color, bold when highlighted.
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

/// Paint the `/model` picker — upstream's Max-subscriber shape per
/// capture at `/tmp/parity-20260420-tmux/04-model-panel/upstream-open.txt`
/// lines 23-33. Structure:
///
/// ```text
///   Select model
///   Switch between Claude models. Applies to this session and future…
///
///   ❯ 1. Default (recommended) ✔  Opus 4.7 with 1M context · Most capable for complex work
///     2. Sonnet                   Sonnet 4.6 · Best for everyday tasks
///     3. Haiku                    Haiku 4.5 · Fastest for quick answers
///
///   ◉ xHigh effort (default) ← → to adjust
///
///   Enter to confirm · Esc to exit
/// ```
///
/// - Subtitle line sits directly under title (dim).
/// - Rows are `N. <label>` single-line with description right-padded
///   at a fixed column for visual alignment.
/// - Checkmark `✔` follows the label of the default/active row.
/// - Effort indicator line renders below the list (014 visual parity).
/// - Footer `Esc to exit` (upstream) vs. `Esc to cancel` (other panels).
fn draw_model_overlay(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    const LABEL_COL: usize = 24; // `1. Default (recommended) ✔  ` = 28, so description starts around col 24-28.
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(menu.options.len() + 7);

    // Title — bold primary.
    lines.push(Line::from(Span::styled(
        format!("  {}", menu.title),
        Style::default()
            .fg(theme::PRIMARY)
            .add_modifier(Modifier::BOLD),
    )));
    // Subtitle — dim, verbatim upstream copy. Line break matches
    // upstream render (capture line 24-25: break before "specify").
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

    // Rows — single-line per option, numbered, with ✔ on the row whose
    // `action_id` matches the overlay's `active_action_id` (the
    // session's live model). Cursor moves independently of the
    // checkmark so arrow keys preview other rows without lying about
    // what's active.
    let active_id = menu.active_action_id.as_deref().unwrap_or("");
    for (i, opt) in menu.options.iter().enumerate() {
        let is_cursor = i == menu.cursor;
        let is_active = opt.action_id == active_id;
        let prefix = if is_cursor { "  ❯ " } else { "    " };
        let num = format!("{}. ", i + 1);
        let check = if is_active { " ✔" } else { "" };
        // Compose the label segment and pad to fixed column so
        // descriptions align across rows. Column count is in chars.
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
        // Active (checked) model row paints SUCCESS green so the user
        // can scan at a glance which model the session is using.
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

    // Inline effort indicator — per upstream ModelPicker.tsx:328
    // `◉ {Level} effort (default) ← → to adjust`. Renders only when
    // the row under the cursor is a model that supports effort levels;
    // haiku (auto-only) hides the indicator entirely. The level shown
    // is the session's current effort when the selected model accepts
    // it, otherwise the selected model's `default_effort`.
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
        // Level color signals whether the user has moved away from
        // the model's default: default = MUTED, non-default = SUCCESS.
        // Makes arrow-adjusted effort visible at a glance.
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

/// Display-name for an effort level in the `/model` indicator. Upstream
/// uses lodash `capitalize` for most levels but renders `xhigh` with
/// mixed case `xHigh` (observed in live capture line 31 of
/// `/tmp/parity-014-rerun/04-model-panel/upstream-open.txt`). Match
/// that casing verbatim.
fn effort_level_display(level: &str) -> String {
    match level.to_lowercase().as_str() {
        "xhigh" => "xHigh".to_string(),
        other => capitalize_first(other),
    }
}

/// Uppercase the first character of `s` in place and leave the rest
/// untouched. Used by the `/model` effort indicator to display
/// `xhigh` → `Xhigh`, `high` → `High`, etc. matching upstream's
/// `capitalize` from `lodash-es` (ModelPicker.tsx:2).
fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Paint the `/effort` picker as a horizontal slider — upstream shape
/// per live capture at `/tmp/parity-20260420-tmux/07-effort-panel/upstream-open.txt`
/// lines 32-38. Geometry constants are byte-exact against the capture.
///
/// Layout:
/// ```text
///                                         Speed                         Intelligence
///                                         ────────────────────▲─────────────────────
///                                         low     medium     high     xhigh      max
///
///
/// ←/→ to change effort · Enter to confirm
/// ```
///
/// 41-char track: 20 `─` + `▲` + 20 `─`. Marker column = `cursor * 10`.
fn draw_effort_slider(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    // Geometry measured against
    // /tmp/parity-014-rerun/07-effort-panel/upstream-open.txt:
    // - left pad = 42 columns
    // - track = 42 chars total (one `▲` + 41 `─`); marker columns
    //   inside the track for the 5 positions are [0, 10, 20, 30, 41]
    //   = `cursor * 41 / 4` with integer division.
    // - `Speed` label at screen col 42, `Intelligence` ends at col 84.
    // - position labels: low@col 42, medium@col 50, high@col 61,
    //   xhigh@col 70, max@col 81 (relative to screen).
    const LEFT_PAD: &str = "                                          "; // 42 spaces
    const TRACK_LEN: usize = 42;
    const POSITIONS: usize = 5;

    let mut lines: Vec<Line<'static>> = Vec::with_capacity(7);

    lines.push(Line::raw(""));

    // Axis label row: `Speed` + 25 spaces + `Intelligence`. 25 = 72-47
    // (Intelligence start) - (Speed end).
    let axis = format!("{LEFT_PAD}Speed{}Intelligence", " ".repeat(25));
    lines.push(Line::from(Span::styled(
        axis,
        Style::default().fg(theme::MUTED),
    )));

    // Track — `▲` at the cursor's column. marker = cursor * 41 / 4
    // across a 42-wide track (positions: 0, 10, 20, 30, 41).
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

    // Position labels — `low`, `medium`, `high`, `xhigh`, `max`
    // spaced to align under their marker columns. Capture line 35:
    // `low     medium     high     xhigh      max`
    // (5 spaces between adjacent labels except `xhigh→max` = 6).
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

/// Render the unified Settings panel — shape-parity with upstream
/// `components/Settings/Settings.tsx` (R-92 evidence: 2.1.114 live
/// capture + reconstructed source).
///
/// Layout:
/// ```text
/// ␣␣␣Status␣␣␣Config␣␣␣Usage
///
/// ␣␣╭────────────────────────────────╮
/// ␣␣│ ⌕ Search settings…             │
/// ␣␣╰────────────────────────────────╯
///
/// ␣␣␣␣<content lines per active tab>
///
/// ␣␣<footer legend>
/// ```
///
/// Tab visual states (matches upstream `Tabs.tsx:204-206`):
/// - current + header focused → bg PERMISSION blue, fg inverse (black), bold
/// - current + header unfocused → reverse video (white-on-dark), bold
/// - non-current → plain MUTED
/// Build Status-tab rows — read-only session metadata per upstream
/// live capture 2026-04-20 (`/tmp/parity-008/01-status-default-full.cap`).
/// Fields that require external data (Session ID, Login method,
/// Organization, Email, MCP servers) show placeholders until their
/// pipelines land.
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

/// Build Config-tab rows — editable in 009. Row order mirrors
/// upstream's Config tab (live capture 2026-04-20) as closely as
/// otherside's schema allows. Unknown-to-otherside settings are
/// omitted rather than stubbed.
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
        // Provider — otherside-native row. Cycle with ← → / Space.
        // Side effect: updates state.session.model to provider.default_model().
        MenuOption {
            label: "Provider".into(),
            action_id: "setting:provider".into(),
            value_display: Some(provider.label().to_string()),
            settings_kind: Some(SettingsRowKind::Provider),
            hint: None,
            ..Default::default()
        },
        // Model — enum cycle keyed by the active provider's model list.
        MenuOption {
            label: "Model".into(),
            action_id: "setting:model".into(),
            value_display: Some(state.session.model.clone()),
            settings_kind: Some(SettingsRowKind::Model),
            hint: None,
            ..Default::default()
        },
        // Default permission mode — enum cycle.
        MenuOption {
            label: "Default permission mode".into(),
            action_id: "setting:permission-mode".into(),
            value_display: Some(permission_label.into()),
            settings_kind: Some(SettingsRowKind::PermissionMode),
            hint: None,
            ..Default::default()
        },
        // Effort — enum cycle.
        MenuOption {
            label: "Effort".into(),
            action_id: "setting:effort".into(),
            value_display: Some(state.session.effort_label.unwrap_or("auto").to_string()),
            settings_kind: Some(SettingsRowKind::Effort),
            hint: None,
            ..Default::default()
        },
        settings_blank(),
        // Bool toggles mirroring upstream's Config tab. Defaults
        // chosen per upstream live capture; persisted value wins
        // when set.
        bool_row("Auto-compact", "auto_compact", state.settings.auto_compact, true),
        bool_row("Show tips", "show_tips", state.settings.show_tips, true),
        // Verbose output — also bool; keyed separately because the
        // live render_verbose flag mirrors this independently.
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
        // Config tab row list ends here. `Default model (persisted)`,
        // `Log level`, `Hooks`, `Statusline` rows were removed
        // 2026-04-20 — they had no upstream equivalent. Per R-92,
        // spec rows must match the live-captured upstream shape.
        // Additional upstream rows still pending (Reduce motion,
        // Rewind code, Use auto mode during plan, Respect
        // .gitignore, Skip /copy picker, Auto-update channel, Local
        // notifications, Push when Claude decides, Output style,
        // Language, Show last response in external editor, Show PR
        // status footer, Auto-connect to IDE, Claude in Chrome,
        // Teammate mode, Default teammate model, Enable Remote
        // Control) — schema additions will land in 010+ behind
        // per-row evidence.
    ]
}

/// Build Usage-tab rows — placeholders until usage-tracking lands.
fn usage_rows() -> Vec<MenuOption> {
    vec![
        settings_ro("Current session", "(tracker pending)"),
        settings_ro("Current week", "(tracker pending)"),
        settings_blank(),
        settings_ro("Status", "Usage telemetry lands with 010-usage-tracking"),
    ]
}

/// Shorthand builder for a read-only Settings row with a 2-col label/value pair.
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

/// Visual blank separator row — no dispatch, no cursor landing.
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

    // Tab bar — three tabs (Stats kept separate per openspec 008
    // Deferred: 010-stats-tab-merge). 3-space indent matches upstream.
    let tabs: [(SettingsTab, &str); 3] = [
        (SettingsTab::Status, "Status"),
        (SettingsTab::Config, "Config"),
        (SettingsTab::Usage, "Usage"),
    ];
    let mut tab_spans: Vec<Span<'static>> = vec![Span::raw("   ")];
    for (i, (tab, label)) in tabs.iter().enumerate() {
        let is_current = *tab == active_tab;
        let style = if is_current && header_focused {
            // Blue pill — focused current tab.
            Style::default()
                .bg(theme::PERMISSION)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD)
        } else if is_current {
            // Reverse-video pill — current but header unfocused
            // (upstream ships `inverse={true}`).
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

    // Search box — visible, non-functional (deferred to
    // 009-settings-search-mode). Border in PERMISSION blue to match
    // upstream `<Pane color="permission">` wrapper around the input.
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

    // Content rows — when the row carries `value_display` (set by
    // the settings row builders), render as two columns:
    //   `  ❯ Label<pad>value`
    // Rows without value_display render as a single-column label
    // (blank separators, fallback legacy info lines).
    const LABEL_PAD: usize = 43; // matches upstream's observed alignment.
    for (i, opt) in menu.options.iter().enumerate() {
        // Blank separator rows render as a plain empty line.
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

    // Footer legend — contextual per focus state (upstream Settings
    // flips legend when the tab row is focused vs. a setting row).
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
        // Upstream `SLIDER_LEVELS` in commands/effort/effort.tsx:9-15
        // = [low, medium, high, xhigh, max]. `auto` is intentionally
        // absent from the picker (014 evidence:
        // /tmp/parity-20260420-tmux/07-effort-panel/upstream-open.txt line 35).
        let m = OverlayMenu::new_effort(None);
        let ids: Vec<&str> = m.options.iter().map(|o| o.action_id.as_str()).collect();
        assert_eq!(ids, vec!["low", "medium", "high", "xhigh", "max"]);
        // Default cursor lands on `high` (midpoint) when nothing preset.
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
        // `auto` resolves to the midpoint fallback per 014 design.
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
        let m = OverlayMenu::new_effort(Some("XHIGH")); // case insensitive
        assert_eq!(m.cursor, 3);
        let m = OverlayMenu::new_effort(Some("max"));
        assert_eq!(m.cursor, 4);
        let m = OverlayMenu::new_effort(Some("unrecognized"));
        assert_eq!(m.cursor, 2);
    }

    #[test]
    fn effort_slider_clamps_at_edges() {
        // Slider does not wrap — ← at position 0 stays at 0,
        // → at position 4 stays at 4 (014 spec: no-wrap).
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
        // Upstream capture lines 32-34 of
        // /tmp/parity-20260420-tmux/04-model-panel/upstream-open.txt:
        //   1. Default (recommended) ✔  Opus 4.7 with 1M context · Most capable for complex work
        //   2. Sonnet                   Sonnet 4.6 · Best for everyday tasks
        //   3. Haiku                    Haiku 4.5 · Fastest for quick answers
        let m = OverlayMenu::new_model_with_effort("claude-opus-4-7[1m]", Some("xhigh"));
        assert_eq!(
            m.options.len(),
            3,
            "upstream shows 3 rows per /tmp/parity-20260420-tmux/04-model-panel/upstream-open.txt lines 32-34"
        );
        assert_eq!(m.options[0].label, "Default (recommended)");
        // Opus row is mutually exclusive per tier: [1m] variant when
        // the account has Max/TeamPremium entitlement, plain 4.7
        // otherwise. Test environment has no OAuth creds so the
        // default resolver returns the non-1M row.
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
        // Default row is preselected when current matches.
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
        // Legacy 5-row constructor fed an unknown model id landed on 0;
        // preserve that fallback for the 3-row shape.
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
        // Second resolve is a no-op — sender already consumed.
        p.resolve(PermissionResponse::Deny);
        let got = futures::executor::block_on(rx).expect("sender fired");
        assert_eq!(got, PermissionResponse::Allow);
    }

    #[test]
    fn commit_effort_yields_set_effort_outcome() {
        // Post-014: 5-position slider, default cursor = 2 (high).
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
        m.cursor = 2; // plan
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
        // Post-014 3-row shape:
        //   cursor 0 → Default (recommended) → claude-opus-4-7[1m]
        //   cursor 1 → Sonnet               → claude-sonnet-4-6
        //   cursor 2 → Haiku                → claude-haiku-4-5
        let m = OverlayMenu::new_model("claude-opus-4-7[1m]");
        // Cursor may land on 0 when the opus row is [1m] (tier has 1M)
        // or fall back to 0 when catalog exposes plain opus. Either
        // way the commit yields an opus variant.
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
        // C71: info rows are navigable now — cursor starts at the
        // first non-empty label which is the first hint line.
        assert_eq!(m.options[m.cursor].label, "line1");
        // commit_outcome on __line__ still returns None (no action).
        assert!(m.commit_outcome().is_none());
    }

    #[test]
    fn info_menu_down_walks_to_close() {
        let mut m = OverlayMenu::new_info(
            PanelKind::Settings(SettingsTab::Status),
            "Status".into(),
            vec!["line1".into(), "line2".into()],
        );
        // line1 → line2 → Close → wrap to line1
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
        // cursor = 2 (high) maps to track column 20 out of 41.
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
        // Flatten to a per-row string by joining cells on each row.
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
        // Marker sits directly above `high` at cursor=2. Find the ▲
        // column and the `high` column in the label row; they should
        // be close (within the label width).
        let marker_row = rows.iter().find(|r| r.contains('▲')).expect("track row");
        let labels_row = rows
            .iter()
            .find(|r| r.contains("low     medium     high"))
            .expect("labels row");
        // Char column (not byte) — ratatui cells are 1-per-char so the
        // screen column of the ▲ is its position in the chars iterator,
        // not `str::find` which returns byte offset.
        let marker_col = marker_row.chars().position(|c| c == '▲').unwrap();
        let high_col = labels_row.chars().collect::<String>().find("high").unwrap();
        // Actually for labels we need a char-aware index too; but `high`
        // is ASCII so byte offset == char offset in the labels row only
        // after we normalize. The labels row contains no multi-byte
        // characters, so `str::find` is safe for it.
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
        // Upstream capture line 36: `◉ xHigh effort (default) ← → to adjust`.
        // Level is capitalized-first (Xhigh). The `(default)` suffix
        // appears because xhigh is Opus's default.
        assert!(joined.contains("◉"), "indicator must render ◉ glyph");
        // Upstream capture line 31 renders xhigh as mixed-case `xHigh`.
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
        // Footer: upstream uses `Esc to exit` on /model (capture line 38),
        // not `Esc to cancel` — branch on PanelKind::Model.
        assert!(
            joined.contains("Enter to confirm · Esc to exit"),
            "model footer must read `Esc to exit` per capture line 38"
        );
    }
}
