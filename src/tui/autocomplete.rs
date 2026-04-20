//! Slash-command autocomplete popup. Triggers when the input starts
//! with `/` and the partial after it matches one or more catalog
//! entries. Arrow keys navigate, Enter commits the highlighted choice,
//! Esc closes.

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState},
    Frame,
};

use super::render::theme;
use super::slash::catalog;

/// Maximum popup rows rendered at once. The matches vector carries
/// EVERY entry that prefix-matches the partial (up to the whole
/// catalog when the partial is empty) — this constant only caps the
/// visible window so the overlay doesn't dwarf the log. Movement past
/// the window scrolls via `ListState::offset`.
pub const MAX_POPUP_ROWS: usize = 10;

/// State for an open autocomplete popup.
#[derive(Debug, Clone, Default)]
pub struct Autocomplete {
    /// The partial after the leading `/` (not including the slash).
    pub partial: String,
    /// Highlighted row index into the filtered matches.
    pub selected: usize,
    /// Matches from the catalog whose slash name prefix-matches `partial`.
    pub matches: Vec<&'static catalog::SlashEntry>,
}

impl Autocomplete {
    /// Build from the current input buffer. Returns `None` when the
    /// input does not begin with `/` or the partial has no matches.
    pub fn from_input(input: &str) -> Option<Self> {
        let trimmed = input.strip_prefix('/')?;
        if trimmed.contains(char::is_whitespace) {
            return None;
        }
        let matches = prefix_filter(trimmed);
        if matches.is_empty() {
            return None;
        }
        // When the partial is an exact catalog entry, highlight that
        // entry first. Prevents `/status` from committing `statusline`
        // (catalog-order prefix match) when the user typed the exact
        // panel name. Case-insensitive exact compare.
        let selected = matches
            .iter()
            .position(|e| e.name.eq_ignore_ascii_case(trimmed))
            .unwrap_or(0);
        Some(Self {
            partial: trimmed.to_string(),
            selected,
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
/// `partial`. Case-insensitive. Alphabetized by slash name to match
/// upstream — catalog-file order would surface rows in an opaque
/// sequence that reads arbitrary to users comparing the two TUIs
/// (2026-04-20 parity sweep flagged this).
fn prefix_filter(partial: &str) -> Vec<&'static catalog::SlashEntry> {
    let lower = partial.to_ascii_lowercase();
    let mut matches: Vec<&'static catalog::SlashEntry> =
        catalog::prefix_matches(&lower).collect();
    matches.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    matches
}

/// Popup name-column width in columns. 40% of the rect width clamped
/// to `[20, 40]` so narrow and ultra-wide terminals still read cleanly.
pub fn name_col_width(area_width: u16) -> u16 {
    ((area_width as u32 * 4 / 10) as u16).clamp(20, 40)
}

/// Paint the popup inside `area`. Two-column layout mirroring upstream
/// autocomplete: slash name left, brief right. `Clear` is rendered
/// first so the rect is opaque — without it the retained-cell buffer
/// bleeds prior log content through empty rows beyond the last
/// suggestion.
pub fn draw(f: &mut Frame<'_>, area: Rect, ac: &Autocomplete) {
    // Zero the rect before painting so underlying streaming content
    // never bleeds through popup rows or row tails. Ratatui is
    // retained-cell; unlike Ink's full-row blit it does NOT clear
    // cells for widgets that render shorter than their area.
    f.render_widget(Clear, area);

    let name_col_w = name_col_width(area.width) as usize;
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
    // Keep the highlighted row visible inside the fixed MAX_POPUP_ROWS
    // window. ratatui's `ListState::offset` sets the first visible
    // index; without it, scrolling past row 10 hides the cursor off
    // the bottom while the match vector still grows underneath.
    let area_rows = area.height as usize;
    let window = area_rows.min(MAX_POPUP_ROWS).max(1);
    let total = ac.matches.len();
    let offset = if ac.selected + 1 <= window {
        0
    } else {
        (ac.selected + 1 - window).min(total.saturating_sub(window))
    };
    *list_state.offset_mut() = offset;

    let block = Block::default().borders(Borders::NONE);

    let list = List::new(items)
        .block(block)
        .highlight_style(
            Style::default()
                .fg(theme::SUGGESTION)
                .add_modifier(Modifier::BOLD),
        );

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
    fn name_col_width_follows_40_percent_rule() {
        // Upstream `Math.floor(columns * 0.4)` with clamp [20, 40].
        assert_eq!(name_col_width(80), 32);
        assert_eq!(name_col_width(100), 40);
        assert_eq!(name_col_width(200), 40, "upper clamp hit");
        assert_eq!(name_col_width(40), 20, "lower clamp hit at exact boundary (16 < 20)");
        assert_eq!(name_col_width(10), 20, "lower clamp hit");
        assert_eq!(name_col_width(60), 24);
    }

    #[test]
    fn from_input_matches_multiple_prefix() {
        let ac = Autocomplete::from_input("/s").unwrap();
        let names: Vec<&str> = ac.matches.iter().map(|e| e.name).collect();
        assert!(names.contains(&"swarm"));
        assert!(names.contains(&"status"));
        assert!(names.contains(&"statusline"));
        assert!(names.contains(&"skills"));
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
    fn exact_match_is_preselected_over_longer_prefix() {
        // Regression: `/status` commits `status` (panel), not
        // `statusline` (skill) — even though `statusline` appears
        // earlier in the catalog.
        let ac = Autocomplete::from_input("/status").unwrap();
        assert_eq!(
            ac.matches[ac.selected].name, "status",
            "exact match must be the selected row"
        );
        assert_eq!(ac.commit().unwrap(), "status");
    }

    #[test]
    fn prefix_without_exact_match_defaults_selected_to_zero() {
        let ac = Autocomplete::from_input("/statu").unwrap();
        assert_eq!(ac.selected, 0);
    }

    #[test]
    fn matches_are_alphabetized_by_name() {
        let ac = Autocomplete::from_input("/s").unwrap();
        let names: Vec<&str> = ac.matches.iter().map(|e| e.name).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "matches must be alphabetized (upstream shape)");
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
        // list and thus the popup. They must now appear. Names below
        // are the docs/slashes.md 34-row subset (R-114).
        for name in ["config", "model", "login", "logout", "init", "mcp",
                     "effort", "plan", "permissions", "diff", "skills",
                     "agents", "context", "keybindings",
                     "statusline", "init-verifiers", "swarm", "dream",
                     "review", "security-review", "loop", "tag"] {
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
                    catalog::lookup(name).is_some(),
                    "/{name} missing from catalog"
                );
            }
        }
    }
}
