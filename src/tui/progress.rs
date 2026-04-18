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

/// Otherside-native Rubik's-cube-face spinner. Eight-frame rotation
/// forward-then-reverse so the pulse reads smoother than a 4-cycle
/// jerk. Pointedly NOT the upstream Braille-dot / asterisk cycle.
const SPINNER_FRAMES: &[char] = &['◰', '◳', '◲', '◱', '◲', '◳', '◰', '◱'];

/// Glitch verb that surfaces ~4% of ticks (C46 easter egg).
const GLITCH_VERB: &str = "Revers... opsss.. Thinking";

/// Otherside-native verb rotation. Every entry is a sideways wink at
/// reverse engineering — unwinding, chasing xrefs, walking the call
/// stack, patching flow, reading past the symbols — without saying
/// the words out loud. Playful, slightly surreal, never corporate.
/// Each tick picks one deterministically so tests reproduce.
const VERBS: &[&str] = &[
    "Thinking",
    "Cogitating",
    "Unwinding",
    "Chasing xrefs",
    "Stepping through",
    "Patching the flow",
    "Peeking offsets",
    "Tracing the call",
    "Walking the wire",
    "Reading the headers",
    "Mapping shadows",
    "Inverting the path",
    "Folding the loop",
    "Shadowing the state",
    "Echoing the return",
    "Unpacking intent",
    "Resolving symbols",
    "Pulling the thread",
    "Drifting upstream",
    "Untangling jumps",
    "Humming the entropy",
    "Reading between frames",
    "Reconstructing context",
    "Sniffing the wire",
    "Walking backwards",
    "Flipping polarity",
    "Peeling layers",
    "Reversing the passage",
    "Observing the drift",
    "Decoding intent",
];


/// Return the frame character for a given tick count.
pub fn spinner_frame(tick: u64) -> char {
    SPINNER_FRAMES[(tick as usize) % SPINNER_FRAMES.len()]
}

/// Decide the verb for this tick. Deterministic hash of the tick for
/// test reproducibility; ~4% of ticks swap to the glitch variant.
/// The non-glitch verb rotates through [`VERBS`] at a slow cadence so
/// the line feels alive without flickering on every spinner beat.
pub fn verb_for_tick(tick: u64) -> &'static str {
    let mixed = tick.wrapping_mul(0x9E3779B97F4A7C15);
    let pct = (mixed >> 56) as u8;
    if pct < 10 {
        // 10/256 ≈ 3.9% — within the C46 3-5% window.
        return GLITCH_VERB;
    }
    // Rotate one verb every ~40 ticks (~2 s at 50 ms cadence).
    let slot = ((tick / 40) as usize) % VERBS.len();
    VERBS[slot]
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
    _thought_ms: u64,
) -> String {
    let frame = spinner_frame(tick);
    let verb = verb_for_tick(tick);
    let elapsed_s = elapsed.as_secs();
    let tokens_part = if output_tokens > 0 {
        format!(" · ↓{output_tokens} tokens")
    } else {
        String::new()
    };
    format!("{frame} {verb}… ({elapsed_s}s{tokens_part} · esc to interrupt)")
}

/// Paint the progress line into `area` (typically a single-row Rect).
pub fn draw(
    f: &mut Frame<'_>,
    area: Rect,
    tick: u64,
    elapsed: Duration,
    output_tokens: u64,
    _thought_ms: u64,
) {
    let frame = spinner_frame(tick);
    let verb = verb_for_tick(tick);
    let elapsed_s = elapsed.as_secs();
    let tokens_part = if output_tokens > 0 {
        format!(" · ↓{output_tokens} tokens")
    } else {
        String::new()
    };

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
            format!("({elapsed_s}s{tokens_part} · esc to interrupt)"),
            Style::default().fg(theme::MUTED),
        ),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spinner_cycles_through_eight_frames() {
        // Forward-then-reverse sweep so the pulse feels fluid.
        assert_eq!(spinner_frame(0), '◰');
        assert_eq!(spinner_frame(1), '◳');
        assert_eq!(spinner_frame(2), '◲');
        assert_eq!(spinner_frame(3), '◱');
        assert_eq!(spinner_frame(4), '◲');
        assert_eq!(spinner_frame(5), '◳');
        assert_eq!(spinner_frame(6), '◰');
        assert_eq!(spinner_frame(7), '◱');
        assert_eq!(spinner_frame(8), '◰');
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
    fn verb_rotates_across_slots() {
        // Across many ticks the non-glitch set should surface more
        // than one distinct verb — rules out a fixed "Thinking".
        use std::collections::HashSet;
        let mut seen: HashSet<&'static str> = HashSet::new();
        for t in 0..2_000u64 {
            let v = verb_for_tick(t * 40);
            if v != GLITCH_VERB {
                seen.insert(v);
            }
        }
        assert!(seen.len() >= 10, "verb rotation stuck at {} distinct verbs", seen.len());
    }

    #[test]
    fn format_progress_includes_core_counters() {
        let text = format_progress_text(0, Duration::from_secs(12), 345, 7_800);
        assert!(text.contains("12s"));
        assert!(text.contains("↓345"));
        assert!(text.contains("esc to interrupt"));
        assert!(!text.contains("thought for"));
    }

    #[test]
    fn format_progress_omits_tokens_when_zero() {
        let text = format_progress_text(0, Duration::from_secs(3), 0, 0);
        assert!(text.contains("3s"));
        assert!(!text.contains("↓"));
        assert!(text.contains("esc to interrupt"));
    }
}
