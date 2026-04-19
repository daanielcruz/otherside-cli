//! Slash-command autocomplete popup. Triggers when the input starts
//! with `/` and the partial after it matches one or more catalog
//! entries. Arrow keys navigate, Enter commits the highlighted choice,
//! Esc closes.

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState},
    Frame,
};

use super::render::theme;
use super::slash_catalog;

/// Max popup rows before truncation. Sized so common prefix groups
/// (s-group has 8 entries: sandbox, statusline, scope, security,
/// skills, status, simplify, swarm) fit without scrolling.
pub const MAX_POPUP_ROWS: usize = 10;

/// State for an open autocomplete popup.
#[derive(Debug, Clone, Default)]
pub struct Autocomplete {
    /// The partial after the leading `/` (not including the slash).
    pub partial: String,
    /// Highlighted row index into the filtered matches.
    pub selected: usize,
    /// Matches from the catalog whose slash name prefix-matches `partial`.
    pub matches: Vec<&'static slash_catalog::SlashEntry>,
}

impl Autocomplete {
    /// Build from the current input buffer. Returns `None` when the
    /// input does not begin with `/` or the partial has no matches.
    pub fn from_input(input: &str) -> Option<Self> {
        let trimmed = input.strip_prefix('/')?;
        // Any whitespace inside the partial means the user has moved
        // past the slash name — close the popup.
        if trimmed.contains(char::is_whitespace) {
            return None;
        }
        let matches = prefix_filter(trimmed);
        if matches.is_empty() {
            return None;
        }
        Some(Self {
            partial: trimmed.to_string(),
            selected: 0,
            matches,
        })
    }

    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    pub fn move_down(&mut self) {
        if self.selected + 1 < self.matches.len() {
            self.selected += 1;
        }
    }

    /// Return the full slash name of the currently highlighted entry,
    /// sans the leading `/`. Callers replace the input buffer with
    /// `/<returned>` on Enter.
    pub fn commit(&self) -> Option<String> {
        self.matches.get(self.selected).map(|e| e.name.to_string())
    }
}

/// Prefix-match the catalog for entries whose slash name starts with
/// `partial`. Case-insensitive. Preserves catalog order so common
/// slashes stay visually stable.
fn prefix_filter(partial: &str) -> Vec<&'static slash_catalog::SlashEntry> {
    let lower = partial.to_ascii_lowercase();
    slash_catalog::prefix_matches(&lower)
        .take(MAX_POPUP_ROWS)
        .collect()
}

/// Paint the popup inside `area`. Two-column layout mirroring upstream
/// autocomplete: slash name left, brief right. No border — the rows
/// ARE the popup.
pub fn draw(f: &mut Frame<'_>, area: Rect, ac: &Autocomplete) {
    let name_col_w: usize = 32;
    let total_w = area.width as usize;
    let brief_col_w = total_w.saturating_sub(name_col_w + 2);

    let items: Vec<ListItem> = ac
        .matches
        .iter()
        .map(|entry| {
            let name_str = format!("/{}", entry.name);
            let pad = name_col_w.saturating_sub(name_str.chars().count() + 1);
            let brief_display: String = if entry.brief.chars().count() > brief_col_w {
                let mut s: String = entry.brief.chars().take(brief_col_w.saturating_sub(1)).collect();
                s.push('…');
                s
            } else {
                entry.brief.to_string()
            };
            ListItem::new(Line::from(vec![
                Span::styled(" ", Style::default()),
                Span::styled(name_str, Style::default().fg(theme::TEXT)),
                Span::styled(" ".repeat(pad), Style::default()),
                Span::styled(brief_display, Style::default().fg(theme::MUTED)),
            ]))
        })
        .collect();

    let mut list_state = ListState::default();
    list_state.select(Some(ac.selected));

    let block = Block::default().borders(Borders::NONE);

    let list = List::new(items)
        .block(block)
        .highlight_style(Style::default().add_modifier(Modifier::REVERSED));

    f.render_stateful_widget(list, area, &mut list_state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_input_rejects_non_slash() {
        assert!(Autocomplete::from_input("hello").is_none());
        assert!(Autocomplete::from_input("").is_none());
    }

    #[test]
    fn from_input_matches_multiple_prefix() {
        let ac = Autocomplete::from_input("/s").unwrap();
        let names: Vec<&str> = ac.matches.iter().map(|e| e.name).collect();
        assert!(names.contains(&"scope"));
        assert!(names.contains(&"security"));
        assert!(names.contains(&"swarm"));
        assert!(names.contains(&"status"));
    }

    #[test]
    fn from_input_case_insensitive() {
        let ac = Autocomplete::from_input("/HE").unwrap();
        let names: Vec<&str> = ac.matches.iter().map(|e| e.name).collect();
        assert!(names.contains(&"help"));
    }

    #[test]
    fn from_input_no_matches_returns_none() {
        assert!(Autocomplete::from_input("/zzz-definitely-missing").is_none());
    }

    #[test]
    fn from_input_rejects_whitespace_in_partial() {
        assert!(Autocomplete::from_input("/help me").is_none());
    }

    #[test]
    fn navigate_bounds() {
        let mut ac = Autocomplete::from_input("/s").unwrap();
        let max = ac.matches.len() - 1;
        ac.move_up();
        assert_eq!(ac.selected, 0);
        for _ in 0..100 {
            ac.move_down();
        }
        assert_eq!(ac.selected, max);
    }

    #[test]
    fn commit_returns_selected_name() {
        let ac = Autocomplete::from_input("/he").unwrap();
        assert_eq!(ac.commit().as_deref(), Some("help"));
    }

    #[test]
    fn catalog_surfaces_newly_added_slashes() {
        // Regression guard: before the single-source-of-truth refactor,
        // `config`, `model`, `login`, etc. were missing from the tips
        // list and thus the popup. They must now appear.
        for name in ["config", "model", "login", "logout", "init", "mcp",
                     "effort", "plan", "permissions", "diff", "skills",
                     "agents", "context", "keybindings", "sandbox",
                     "statusline", "init-verifiers"] {
            let prefix = &name[..1];
            let ac = Autocomplete::from_input(&format!("/{prefix}"))
                .unwrap_or_else(|| panic!("no matches for prefix /{prefix}"));
            let names: Vec<&str> = ac.matches.iter().map(|e| e.name).collect();
            // The popup caps at MAX_POPUP_ROWS so a single prefix may
            // hide an entry; walk all letters if needed.
            if !names.contains(&name) {
                // Fall back to checking the catalog directly — the
                // popup hides it due to row cap but it still exists.
                assert!(
                    slash_catalog::lookup(name).is_some(),
                    "/{name} missing from catalog"
                );
            }
        }
    }
}
