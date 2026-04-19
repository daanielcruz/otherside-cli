//! Progress line — the "[spinner] Thinking… (elapsed · ↓tokens · thought for Ns)"
//! row that sits between the streaming area and the prompt bar while
//! inference is live.
//!
//! Per C43 the spinner is otherside-native — rotating cube faces, not
//! upstream's Braille dots. Per C46 the format mirrors upstream's
//! structure with our own verb vocabulary. The VERB is seeded ONCE per
//! turn (submit picks a verb via `pick_verb_for_turn` from a monotonic
//! counter) and held stable under tick-indexed spinner-frame rotation
//! — matches upstream's `useState(() => sample(verbs))` shape. The 4%
//! glitch variant was removed (013 §4) — tick-indexed verb rotation
//! caused the word to flicker mid-turn, which contradicts upstream's
//! stable-word-per-turn UX.

use std::sync::atomic::{AtomicU64, Ordering};
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

/// Otherside-native verb rotation. Every entry is a quiet, off-angle
/// wink at reverse engineering — all jargon stripped. No `xrefs`,
/// `symbols`, `frames`, `wire`, `polarity`, `intent`, `context`. Each
/// verb should read like a harmless everyday motion and still carry
/// the feeling of walking something backwards, listening to something
/// hidden, or watching what was supposed to stay off-screen. Playful,
/// slightly surreal, never corporate.
const VERBS: &[&str] = &[
    "Thinking",
    "Cogitating",
    "Unwinding",
    "Squinting",
    "Eavesdropping",
    "Folding the loop",
    "Chasing echoes",
    "Checking mirrors",
    "Walking widdershins",
    "Reading sideways",
    "Echo-locating",
    "Unbuttoning",
    "Thumbing through",
    "Measuring drift",
    "Counting hops",
    "Pacing backwards",
    "Tiptoeing",
    "Listening for clicks",
    "Tracing whispers",
    "Parsing silences",
    "Humming",
    "Stacking mirrors",
    "Rewiring nerves",
    "Drifting upstream",
    "Reading marginalia",
    "Consulting the auguries",
    "Nudging the dial",
    "Unraveling stitches",
    "Minding the gaps",
    "Cracking knuckles",
];

/// Monotonic turn counter seeded from an AtomicU64. Each call to
/// `next_turn_seed` returns a fresh value — `submit()` feeds this into
/// `pick_verb_for_turn` so each turn owns one deterministic verb.
static TURN_SEED: AtomicU64 = AtomicU64::new(0);

/// Bump and return the next turn seed. Called from `ConversationState::submit`
/// so each turn gets a unique deterministic verb slot.
pub fn next_turn_seed() -> u64 {
    TURN_SEED.fetch_add(1, Ordering::Relaxed)
}

/// Deterministically pick one verb for a turn seed. Uniform over
/// `VERBS`; same seed always returns the same verb so tests and
/// retries stay stable.
pub fn pick_verb_for_turn(seed: u64) -> &'static str {
    VERBS[(seed as usize) % VERBS.len()]
}

/// Return the frame character for a given tick count.
pub fn spinner_frame(tick: u64) -> char {
    SPINNER_FRAMES[(tick as usize) % SPINNER_FRAMES.len()]
}

/// Format the progress line text (no styling) given live state + the
/// turn-scoped verb and optional thinking-effort label. Upstream shape:
///
/// ```text
/// ✽ Concocting… (12m 40s · ↑ 8.9k tokens · thinking with xhigh effort)
/// ```
pub fn format_progress_text(
    tick: u64,
    verb: &str,
    elapsed: Duration,
    tokens_up: u64,
    _thought_ms: u64,
    effort_label: Option<&str>,
) -> String {
    let frame = spinner_frame(tick);
    let elapsed_str = format_elapsed(elapsed);
    let tokens_part = if tokens_up > 0 {
        format!(" · ↑ {} tokens", format_tokens_compact(tokens_up))
    } else {
        String::new()
    };
    let effort_part = match effort_label {
        Some(label) if !label.is_empty() && label != "none" => {
            format!(" · thinking with {label} effort")
        }
        _ => String::new(),
    };
    format!("{frame} {verb}… ({elapsed_str}{tokens_part}{effort_part})")
}

/// Upstream-style elapsed format: `Ns` under a minute, `Nm Ns`
/// otherwise. Keeps the progress line compact and readable.
pub fn format_elapsed(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    if secs < 60 {
        format!("{secs}s")
    } else {
        let m = secs / 60;
        let s = secs % 60;
        format!("{m}m {s}s")
    }
}

/// Upstream-style token count: `N` under 1000, `N.Nk` otherwise,
/// rounded to one decimal when sub-10k. `8873 → 8.9k`, `123 → 123`,
/// `12_345 → 12k`.
pub fn format_tokens_compact(n: u64) -> String {
    if n < 1_000 {
        n.to_string()
    } else if n < 10_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        format!("{}k", n / 1_000)
    }
}

/// Paint the progress line into `area` (typically a single-row Rect).
/// Shape mirrors `format_progress_text` — `↑ Nk tokens` for input,
/// `Nm Ns` elapsed, `thinking with <level> effort` when set.
pub fn draw(
    f: &mut Frame<'_>,
    area: Rect,
    tick: u64,
    verb: &str,
    elapsed: Duration,
    tokens_up: u64,
    _thought_ms: u64,
    effort_label: Option<&str>,
) {
    let frame = spinner_frame(tick);
    let elapsed_str = format_elapsed(elapsed);
    let tokens_part = if tokens_up > 0 {
        format!(" · ↑ {} tokens", format_tokens_compact(tokens_up))
    } else {
        String::new()
    };
    let effort_part = match effort_label {
        Some(label) if !label.is_empty() && label != "none" => {
            format!(" · thinking with {label} effort")
        }
        _ => String::new(),
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
            format!("({elapsed_str}{tokens_part}{effort_part})"),
            Style::default().fg(theme::MUTED),
        ),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn spinner_cycles_through_eight_frames() {
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
    fn pick_verb_for_turn_is_deterministic() {
        let a = pick_verb_for_turn(42);
        let b = pick_verb_for_turn(42);
        assert_eq!(a, b);
    }

    #[test]
    fn pick_verb_for_turn_spans_the_set() {
        // Across `VERBS.len()` consecutive seeds we hit every verb at
        // least once — confirms the modulo indexing covers the slice.
        let mut seen: HashSet<&'static str> = HashSet::new();
        for s in 0..(VERBS.len() as u64) {
            seen.insert(pick_verb_for_turn(s));
        }
        assert_eq!(seen.len(), VERBS.len());
    }

    #[test]
    fn next_turn_seed_is_monotonic() {
        let a = next_turn_seed();
        let b = next_turn_seed();
        let c = next_turn_seed();
        assert!(b > a);
        assert!(c > b);
    }

    #[test]
    fn format_progress_upstream_shape() {
        let text = format_progress_text(
            0,
            "Concocting",
            Duration::from_secs(760), // 12m 40s
            8_873,                    // renders as 8.9k
            0,
            Some("xhigh"),
        );
        assert!(text.contains("12m 40s"), "elapsed: {text}");
        assert!(text.contains("↑ 8.9k tokens"), "tokens: {text}");
        assert!(text.contains("Concocting"));
        assert!(text.contains("thinking with xhigh effort"));
    }

    #[test]
    fn format_progress_omits_tokens_when_zero() {
        let text = format_progress_text(0, "Cogitating", Duration::from_secs(3), 0, 0, None);
        assert!(text.contains("3s"));
        assert!(!text.contains("↑"));
        assert!(!text.contains("thinking with"));
    }

    #[test]
    fn format_progress_uses_supplied_verb() {
        let text = format_progress_text(0, "Unwinding", Duration::from_secs(1), 0, 0, None);
        assert!(text.contains("Unwinding"));
    }

    #[test]
    fn format_progress_hides_effort_when_none() {
        let text = format_progress_text(
            0,
            "Thinking",
            Duration::from_secs(1),
            0,
            0,
            Some("none"),
        );
        assert!(!text.contains("thinking with"));
    }

    #[test]
    fn format_elapsed_splits_at_minute() {
        assert_eq!(format_elapsed(Duration::from_secs(45)), "45s");
        assert_eq!(format_elapsed(Duration::from_secs(60)), "1m 0s");
        assert_eq!(format_elapsed(Duration::from_secs(760)), "12m 40s");
    }

    #[test]
    fn format_tokens_compact_matches_upstream() {
        assert_eq!(format_tokens_compact(999), "999");
        assert_eq!(format_tokens_compact(1_000), "1.0k");
        assert_eq!(format_tokens_compact(8_873), "8.9k");
        assert_eq!(format_tokens_compact(12_345), "12k");
        assert_eq!(format_tokens_compact(0), "0");
    }
}
