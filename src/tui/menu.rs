//! Overlay-menu primitive — the reusable widget that powers `/effort`
//! today and every upstream `local-jsx` slash (`/help`, `/model`,
//! `/permissions`, ExitConfirm, …) as they land.
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
//!   `SetEffort` flips thinking config, `ExitApp` terminates, etc.
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
//!
//! # Why a single primitive
//!
//! 21 `MenuKind` variants all share the same shape (title + selectable
//! options + commit string). The only per-variant logic is:
//! 1. How to populate `options` from current state.
//! 2. How to translate the committed option into a session-state
//!    mutation (`OverlayMenuOutcome`).
//!
//! Keeping both inside [`OverlayMenu`] via constructor fns + outcome
//! plumbing means new menus (`/help` next wave, etc.) are one
//! constructor + one outcome arm, not a fresh widget implementation.

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use super::render::theme;
use super::slash_catalog::MenuKind;

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
    pub kind: MenuKind,
    pub title: String,
    pub options: Vec<MenuOption>,
    pub cursor: usize,
}

impl OverlayMenu {
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
            kind: MenuKind::Effort,
            title: "Set effort level".into(),
            options,
            cursor,
        }
    }

    /// Move the cursor up; wraps to the last row when at the top.
    pub fn move_up(&mut self) {
        if self.options.is_empty() {
            return;
        }
        if self.cursor == 0 {
            self.cursor = self.options.len() - 1;
        } else {
            self.cursor -= 1;
        }
    }

    /// Move the cursor down; wraps to the first row when at the bottom.
    pub fn move_down(&mut self) {
        if self.options.is_empty() {
            return;
        }
        self.cursor = (self.cursor + 1) % self.options.len();
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
        match self.kind {
            MenuKind::Effort => Some(OverlayMenuOutcome::SetEffort {
                action_id: selected.action_id.clone(),
                label: selected.label.clone(),
            }),
            _ => None,
        }
    }
}

/// What the event loop does after the user hits Enter inside the
/// overlay. One variant per outcome class; per-MenuKind commits map
/// into these during [`OverlayMenu::commit_outcome`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayMenuOutcome {
    /// `/effort` — flip the session's thinking level. `action_id` is
    /// the lowercase canonical name accepted by
    /// [`crate::thinking::ThinkingLevel::from_str`] plus `"auto"`.
    SetEffort { action_id: String, label: String },
}

/// Minimum height the overlay widget needs to render cleanly (title +
/// border padding + at least one option row). Layout callers short-
/// circuit to an inline note when the prompt area is smaller than this.
pub const MIN_HEIGHT: u16 = 5;

/// Paint the overlay into `area`. Call site: `render.rs` when
/// `state.active_menu.is_some()` — the widget owns its frame.
pub fn draw_overlay(f: &mut Frame<'_>, area: Rect, menu: &OverlayMenu) {
    if area.height < MIN_HEIGHT {
        return;
    }
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(menu.options.len() * 2 + 2);

    // Hint header: arrow keys + enter + esc. Dim so the list beneath
    // remains visually dominant.
    lines.push(Line::from(Span::styled(
        "  ↑/↓ select  ·  Enter confirm  ·  Esc cancel".to_string(),
        Style::default().fg(theme::MUTED),
    )));
    lines.push(Line::raw(""));

    for (i, opt) in menu.options.iter().enumerate() {
        let is_cursor = i == menu.cursor;
        let marker = if is_cursor { "❯ " } else { "  " };
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
            Span::styled(opt.label.clone(), label_style),
        ]));
        if let Some(hint) = opt.hint.as_ref() {
            lines.push(Line::from(vec![
                Span::styled("    ".to_string(), Style::default().fg(theme::MUTED)),
                Span::styled(hint.clone(), Style::default().fg(theme::MUTED)),
            ]));
        }
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            format!(" {} ", menu.title),
            Style::default()
                .fg(theme::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ))
        .border_style(Style::default().fg(theme::MUTED));

    let paragraph = Paragraph::new(lines).block(block);
    f.render_widget(paragraph, area);
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
    fn commit_effort_yields_set_effort_outcome() {
        let mut m = OverlayMenu::new_effort(None);
        m.cursor = 3; // high
        let outcome = m.commit_outcome().expect("effort yields outcome");
        match outcome {
            OverlayMenuOutcome::SetEffort { action_id, label } => {
                assert_eq!(action_id, "high");
                assert_eq!(label, "high");
            }
        }
    }
}
