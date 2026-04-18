//! Progress line — the "[spinner] Thinking… (elapsed · ↓tokens · thought for Ns)"
//! row that sits between the streaming area and the prompt bar while
//! inference is live.
//!
//! Per C43 the spinner is otherside-native — rotating cube faces, not
//! upstream's Braille dots. Per C46 the format mirrors upstream's
//! structure with our own verb vocabulary. Per C46's Easter-egg clause,
//! with 3–5% probability per tick the verb swaps to
//! `Revers... opsss.. Thinking` — a one-frame glitch then snap back.

use std::time::Duration;

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use super::render::theme;

/// Otherside-native Rubik's-cube-face spinner. Four quadrant glyphs
/// evoke cube rotation. Pointedly NOT the upstream Braille-dot cycle.
const SPINNER_FRAMES: &[char] = &['◰', '◳', '◲', '◱'];

/// Glitch verb that surfaces ~4% of ticks (C46 easter egg).
const GLITCH_VERB: &str = "Revers... opsss.. Thinking";

/// Canonical verb for the progress line.
const VERB: &str = "Thinking";

/// Return the frame character for a given tick count.
pub fn spinner_frame(tick: u64) -> char {
    SPINNER_FRAMES[(tick as usize) % SPINNER_FRAMES.len()]
}

/// Decide the verb for this tick. Deterministic hash of the tick for
/// test reproducibility; ~4% of ticks swap to the glitch variant.
pub fn verb_for_tick(tick: u64) -> &'static str {
    // Simple LCG-ish mix — cheap and stable across platforms.
    let mixed = tick.wrapping_mul(0x9E3779B97F4A7C15);
    let pct = (mixed >> 56) as u8; // top 8 bits as 0..=255
    if pct < 10 {
        // 10/256 ≈ 3.9% — within the C46 3-5% window.
        GLITCH_VERB
    } else {
        VERB
    }
}

/// Format the progress line text (no styling) given live state.
///
/// - `elapsed` = wall clock since the request went out
/// - `output_tokens` = running output-token count from SSE usage events
/// - `thought_ms` = accumulated thinking time (pre-first-delta); 0 before first
pub fn format_progress_text(
    tick: u64,
    elapsed: Duration,
    output_tokens: u64,
    thought_ms: u64,
) -> String {
    let frame = spinner_frame(tick);
    let verb = verb_for_tick(tick);
    let elapsed_s = elapsed.as_secs();
    let thought_s = thought_ms / 1_000;
    format!(
        "{frame} {verb}… ({elapsed_s}s · ↓{output_tokens} · thought for {thought_s}s)"
    )
}

/// Paint the progress line into `area` (typically a single-row Rect).
pub fn draw(
    f: &mut Frame<'_>,
    area: Rect,
    tick: u64,
    elapsed: Duration,
    output_tokens: u64,
    thought_ms: u64,
) {
    let frame = spinner_frame(tick);
    let verb = verb_for_tick(tick);
    let elapsed_s = elapsed.as_secs();
    let thought_s = thought_ms / 1_000;

    let line = Line::from(vec![
        Span::styled(
            format!("{frame} "),
            Style::default().fg(theme::PRIMARY).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("{verb}… "),
            Style::default().fg(theme::PRIMARY),
        ),
        Span::styled(
            format!("({elapsed_s}s · ↓{output_tokens} · thought for {thought_s}s)"),
            Style::default().fg(theme::MUTED),
        ),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spinner_cycles_through_four_frames() {
        assert_eq!(spinner_frame(0), '◰');
        assert_eq!(spinner_frame(1), '◳');
        assert_eq!(spinner_frame(2), '◲');
        assert_eq!(spinner_frame(3), '◱');
        assert_eq!(spinner_frame(4), '◰');
    }

    #[test]
    fn verb_glitch_probability_in_expected_window() {
        // Over 10k ticks, glitch should fire 3-5% of the time.
        let glitches = (0..10_000u64)
            .filter(|t| verb_for_tick(*t) == GLITCH_VERB)
            .count();
        assert!(
            (300..=500).contains(&glitches),
            "glitch frequency out of C46 window: {glitches} / 10_000"
        );
    }

    #[test]
    fn verb_deterministic_for_tick() {
        let a = verb_for_tick(42);
        let b = verb_for_tick(42);
        assert_eq!(a, b);
    }

    #[test]
    fn format_progress_includes_all_counters() {
        let text = format_progress_text(
            0,
            Duration::from_secs(12),
            345,
            7_800,
        );
        assert!(text.contains("12s"));
        assert!(text.contains("↓345"));
        assert!(text.contains("thought for 7s"));
    }
}
