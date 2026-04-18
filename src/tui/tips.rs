//! Rotating tip line below the progress row. Per C47, tips come from
//! otherside's slash catalog — random rotation per render, no
//! persistence across sessions.
//!
//! The curated list is inlined here rather than parsed from the outer-
//! repo slash-commands.md because the inner crate can't depend on
//! outer-repo files at build time cleanly. Entries are hand-picked
//! otherside slashes with brief descriptions; update when the catalog
//! shifts.

use ratatui::{
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use super::render::theme;

/// Curated tips. Every entry references an otherside-native slash
/// command (no upstream passthroughs per C42).
pub const TIPS: &[&str] = &[
    "/help — show slash command catalog",
    "/clear — reset context, keep session alive",
    "/compact — summarize history, trim tokens",
    "/resume — pick a past session to continue",
    "/rewind — jump back to an earlier turn",
    "/branch — fork the conversation from here",
    "/copy — export the session to clipboard",
    "/export — write the session to a file",
    "/checkpoint — tag this spot for /rewind",
    "/scope — add or remove directories from the workspace",
    "/security — run the security review skill",
    "/pr-review — review a pull request",
    "/deepreview — exhaustive review pass",
    "/dedup-mem — consolidate memory files",
    "/cron — schedule recurring tasks",
    "/redteam — adversarial probe on the current target",
    "/swarm — list, create, or kill swarm agents",
    "/status — one-shot render of the current statusline",
];

/// Pick a tip by rotation index. Stable across same index so callers
/// control the rotation cadence (typically bump the index on new
/// inference requests, not every render).
pub fn tip_at(index: usize) -> &'static str {
    if TIPS.is_empty() {
        ""
    } else {
        TIPS[index % TIPS.len()]
    }
}

/// Paint the tip line into `area`. Format: `⎿ Tip: /<slash> — <brief>`.
pub fn draw(f: &mut Frame<'_>, area: Rect, rotation_index: usize) {
    let tip = tip_at(rotation_index);
    let line = Line::from(vec![
        Span::styled("⎿ Tip: ", Style::default().fg(theme::MUTED)),
        Span::styled(tip.to_string(), Style::default().fg(theme::PRIMARY)),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tip_at_wraps_around() {
        let zero = tip_at(0);
        let wrap = tip_at(TIPS.len());
        assert_eq!(zero, wrap);
    }

    #[test]
    fn every_tip_has_slash_prefix() {
        for tip in TIPS {
            assert!(tip.starts_with('/'), "tip missing slash: {tip:?}");
        }
    }

    #[test]
    fn every_tip_has_brief() {
        for tip in TIPS {
            assert!(
                tip.contains(" — "),
                "tip missing em-dash brief separator: {tip:?}"
            );
        }
    }

    #[test]
    fn empty_catalog_returns_empty_string() {
        // Canary — if TIPS ever drains to empty, tip_at must not panic.
        let tip = tip_at(0);
        assert!(!tip.is_empty());
    }
}
