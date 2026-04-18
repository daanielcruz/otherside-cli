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
use super::tips::TIPS;

/// Max popup rows before truncation.
pub const MAX_POPUP_ROWS: usize = 7;

/// State for an open autocomplete popup.
#[derive(Debug, Clone, Default)]
pub struct Autocomplete {
    /// The partial after the leading `/` (not including the slash).
    pub partial: String,
    /// Highlighted row index into the filtered matches.
    pub selected: usize,
    /// Matches from TIPS whose slash name prefix-matches `partial`.
    pub matches: Vec<&'static str>,
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
        let matches = fuzzy_filter(trimmed);
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
        let entry = self.matches.get(self.selected)?;
        Some(slash_name_of(entry).to_string())
    }
}

/// Prefix-match the catalog for entries whose slash name starts with
/// `partial`. Case-insensitive. Results retain catalog order so common
/// slashes stay visually stable.
fn fuzzy_filter(partial: &str) -> Vec<&'static str> {
    let lower = partial.to_ascii_lowercase();
    TIPS.iter()
        .copied()
        .filter(|entry| {
            let name = slash_name_of(entry).to_ascii_lowercase();
            name.starts_with(&lower)
        })
        .take(MAX_POPUP_ROWS)
        .collect()
}

/// Extract the `/<slash>` name from a tip string (`/foo — brief`).
fn slash_name_of(tip: &str) -> &str {
    let with_leading = tip.split(' ').next().unwrap_or("");
    with_leading.strip_prefix('/').unwrap_or(with_leading)
}

/// Paint the popup inside `area`. Caller sizes `area` to
/// `matches.len() + 2` rows (+2 for block borders).
pub fn draw(f: &mut Frame<'_>, area: Rect, ac: &Autocomplete) {
    let items: Vec<ListItem> = ac
        .matches
        .iter()
        .map(|entry| {
            let name = slash_name_of(entry);
            let brief = entry.strip_prefix(&format!("/{name} — ")).unwrap_or("");
            ListItem::new(Line::from(vec![
                Span::styled(
                    format!("/{name}"),
                    Style::default()
                        .fg(theme::PRIMARY)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("  ", Style::default()),
                Span::styled(brief.to_string(), Style::default().fg(theme::MUTED)),
            ]))
        })
        .collect();

    let mut list_state = ListState::default();
    list_state.select(Some(ac.selected));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::PRIMARY))
        .title(Span::styled(
            " /slash — ↑↓ navigate · enter run · esc close ",
            Style::default().fg(theme::MUTED),
        ));

    let list = List::new(items)
        .block(block)
        .highlight_style(
            Style::default()
                .bg(theme::PRIMARY)
                .fg(ratatui::style::Color::White)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▶ ");

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
        let names: Vec<&str> = ac
            .matches
            .iter()
            .map(|e| slash_name_of(e))
            .collect();
        // `/scope`, `/security`, `/swarm`, `/status` all start with `s`.
        assert!(names.iter().any(|n| *n == "scope"));
        assert!(names.iter().any(|n| *n == "security"));
        assert!(names.iter().any(|n| *n == "swarm"));
        assert!(names.iter().any(|n| *n == "status"));
    }

    #[test]
    fn from_input_case_insensitive() {
        let ac = Autocomplete::from_input("/HE").unwrap();
        let names: Vec<&str> = ac
            .matches
            .iter()
            .map(|e| slash_name_of(e))
            .collect();
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
        // Start at 0; up does nothing.
        ac.move_up();
        assert_eq!(ac.selected, 0);
        // Down until last.
        for _ in 0..100 {
            ac.move_down();
        }
        assert_eq!(ac.selected, max);
    }

    #[test]
    fn commit_returns_selected_name() {
        let mut ac = Autocomplete::from_input("/he").unwrap();
        assert_eq!(ac.commit().as_deref(), Some("help"));
        ac.move_down();
        // No second `he*` match typically — commit still stable if it exists.
        let _ = ac.commit();
    }
}
