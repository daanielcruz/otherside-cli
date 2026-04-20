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
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Clear, Paragraph},
    Frame,
};

use super::render::theme;
use super::slash::catalog::PanelKind;

/// One selectable row inside an [`OverlayMenu`].
#[derive(Debug, Clone)]
pub struct MenuOption {
    /// Display text rendered in the option row.
    pub label: String,
    /// Opaque action id — interpreted by the per-variant commit-to-
    /// outcome mapper. For `/effort` this is the thinking level name.
    pub action_id: String,
    /// Optional secondary line (dim, 1 row). `None` suppresses the hint.
    pub hint: Option<String>,
}

/// Modal overlay state. `active_menu` on `ConversationState` wraps this
/// in `Option` so `Some` ≡ "a menu is capturing focus".
#[derive(Debug, Clone)]
pub struct OverlayMenu {
    pub kind: PanelKind,
    pub title: String,
    pub options: Vec<MenuOption>,
    pub cursor: usize,
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
        Self {
            kind,
            title,
            options: options_with_hints,
            cursor,
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
            },
            MenuOption {
                label: "acceptEdits".into(),
                action_id: "acceptEdits".into(),
                hint: Some("auto-approve Edit / Write / NotebookEdit in safe paths".into()),
            },
            MenuOption {
                label: "plan".into(),
                action_id: "plan".into(),
                hint: Some("read-only exploration — all mutations denied".into()),
            },
            MenuOption {
                label: "yolo".into(),
                action_id: "yolo".into(),
                hint: Some("no prompts, every tool allowed (dangerous)".into()),
            },
        ];
        let cursor = match current {
            crate::config::settings::PermissionMode::Default => 0,
            crate::config::settings::PermissionMode::AcceptEdits => 1,
            crate::config::settings::PermissionMode::Plan => 2,
            crate::config::settings::PermissionMode::Yolo => 3,
        };
        Self {
            kind: PanelKind::Permissions,
            title: "Set permission mode".into(),
            options,
            cursor,
        }
    }

    /// Build the `/model` picker — list known aliases with the current
    /// id preselected. Reads a bundled static list since otherside does
    /// not (yet) query the provider for `/v1/models`.
    pub fn new_model(current: &str) -> Self {
        const MODELS: &[(&str, &str)] = &[
            ("claude-opus-4-7", "Opus 4.7 — newest top-tier"),
            ("claude-opus-4-7[1m]", "Opus 4.7 with 1M context window"),
            ("claude-opus-4-6", "Opus 4.6 — prior top-tier"),
            ("claude-sonnet-4-6", "Sonnet 4.6 — balanced"),
            ("claude-haiku-4-5", "Haiku 4.5 — fastest / cheapest"),
        ];
        let options: Vec<MenuOption> = MODELS
            .iter()
            .map(|(id, desc)| MenuOption {
                label: (*id).to_string(),
                action_id: (*id).to_string(),
                hint: Some((*desc).to_string()),
            })
            .collect();
        let cursor = options
            .iter()
            .position(|o| o.action_id == current)
            .unwrap_or(0);
        Self {
            kind: PanelKind::Model,
            title: "Switch model".into(),
            options,
            cursor,
        }
    }

    /// Build the `/effort` overlay — 6 rows matching upstream's
    /// `executeEffort` arg grammar: `auto, low, medium, high, xhigh, max`.
    /// When `current` matches one of the rows, that row is preselected
    /// so `Enter` without navigation is a no-op confirmation.
    pub fn new_effort(current: Option<&str>) -> Self {
        let options = vec![
            MenuOption {
                label: "auto".into(),
                action_id: "auto".into(),
                hint: Some("default effort level for the model".into()),
            },
            MenuOption {
                label: "low".into(),
                action_id: "low".into(),
                hint: Some("quick, straightforward implementation".into()),
            },
            MenuOption {
                label: "medium".into(),
                action_id: "medium".into(),
                hint: Some("balanced approach with standard testing".into()),
            },
            MenuOption {
                label: "high".into(),
                action_id: "high".into(),
                hint: Some("comprehensive work with extensive testing".into()),
            },
            MenuOption {
                label: "xhigh".into(),
                action_id: "xhigh".into(),
                hint: Some("deeper reasoning than high".into()),
            },
            MenuOption {
                label: "max".into(),
                action_id: "max".into(),
                hint: Some("maximum capability with deepest reasoning".into()),
            },
        ];
        let cursor = current
            .map(str::to_lowercase)
            .and_then(|c| options.iter().position(|o| o.action_id == c))
            .unwrap_or(0);
        Self {
            kind: PanelKind::Effort,
            title: "Set effort level".into(),
            options,
            cursor,
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
    // title + blank + per-option(label + optional hint) + blank + footer
    let mut rows: u16 = 2; // title + blank
    for opt in &menu.options {
        rows = rows.saturating_add(1);
        if opt.action_id != "__line__" && opt.hint.is_some() {
            rows = rows.saturating_add(1);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_effort_has_six_upstream_options() {
        let m = OverlayMenu::new_effort(None);
        let ids: Vec<&str> = m.options.iter().map(|o| o.action_id.as_str()).collect();
        assert_eq!(ids, vec!["auto", "low", "medium", "high", "xhigh", "max"]);
        assert_eq!(m.cursor, 0);
    }

    #[test]
    fn new_effort_preselects_current_level() {
        let m = OverlayMenu::new_effort(Some("high"));
        assert_eq!(m.cursor, 3);
        let m = OverlayMenu::new_effort(Some("XHIGH")); // case insensitive
        assert_eq!(m.cursor, 4);
        let m = OverlayMenu::new_effort(Some("unrecognized"));
        assert_eq!(m.cursor, 0);
    }

    #[test]
    fn move_up_wraps_to_last() {
        let mut m = OverlayMenu::new_effort(None);
        assert_eq!(m.cursor, 0);
        m.move_up();
        assert_eq!(m.cursor, m.options.len() - 1);
    }

    #[test]
    fn move_down_wraps_to_first() {
        let mut m = OverlayMenu::new_effort(None);
        m.jump_to_last();
        m.move_down();
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
        let mut m = OverlayMenu::new_effort(None);
        m.cursor = 3; // high
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
        let mut m = OverlayMenu::new_model("claude-opus-4-7");
        m.cursor = 1; // opus 1m
        let outcome = m.commit_outcome().expect("model yields outcome");
        match outcome {
            OverlayMenuOutcome::SetModel { model_id } => {
                assert_eq!(model_id, "claude-opus-4-7[1m]");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn info_menu_cursor_starts_on_first_content_row() {
        let m = OverlayMenu::new_info(
            PanelKind::Status,
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
            PanelKind::Status,
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
}
