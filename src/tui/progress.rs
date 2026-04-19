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

/// Star-family spinner matching upstream `getDefaultCharacters()` +
/// its reverse (`components/Spinner/SpinnerGlyph.tsx::SPINNER_FRAMES`).
/// darwin uses `· ✢ ✳ ✶ ✻ ✽`; we keep that set across platforms since
/// it's the visible parity target. Forward-then-reverse creates a
/// breathing "small → large → small" pulse rather than a hard wrap.
const SPINNER_FRAMES: &[char] = &[
    '·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·',
];

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

/// Return the frame character for a given tick count. The event
/// loop ticks at ~20 fps (50 ms); dividing the index by
/// [`SPINNER_FRAME_RATIO`] slows the rotation so the cube faces
/// read as a breathing pulse rather than a dizzy strobe.
pub fn spinner_frame(tick: u64) -> char {
    SPINNER_FRAMES[(tick as usize / SPINNER_FRAME_RATIO) % SPINNER_FRAMES.len()]
}

/// Ticks per spinner frame. Event loop runs at ~50 ms/tick;
/// `3` → one frame every 150 ms, full 8-frame cycle every 1.2 s.
/// Tune higher for a slower pulse, lower for snappier motion.
const SPINNER_FRAME_RATIO: usize = 3;

/// Format the progress line text (no styling) given live state + the
/// turn-scoped verb and optional thinking-effort label. Upstream
/// shape: `⏺ Whirlpooling… (22m 58s · ↑ 32.4k tokens · thought for 2s)`.
/// otherside adds a `↓ tokens` segment so users see output token
/// pressure too — the up-arrow tells them how much context they're
/// spending, the down-arrow tells them what's coming back.
pub fn format_progress_text(
    tick: u64,
    verb: &str,
    elapsed: Duration,
    tokens_up: u64,
    tokens_down: u64,
    thought_ms: u64,
    effort_label: Option<&str>,
) -> String {
    let _ = effort_label; // upstream shape shows `thought for Xs`
                          // instead of an effort chip; kept on the
                          // signature for future use without churn.
    let frame = spinner_frame(tick);
    let elapsed_str = format_elapsed(elapsed);
    // Upstream shows EITHER ↑ (upload-wait phase) OR ↓ (response
    // streaming) — never both at once. Switch to ↓ once any output
    // tokens have arrived; before that, surface the ↑ input total
    // so the user sees what's being sent. Matches observed live
    // claude-code output:
    //   ✽ Vibing… (53s · ↑ 255 tokens · thought for 7s)
    //   ✻ Vibing… (1m 5s · ↓ 383 tokens · thought for 7s)
    let tokens_part = if tokens_down > 0 {
        format!(" · ↓ {} tokens", format_tokens_compact(tokens_down))
    } else if tokens_up > 0 {
        format!(" · ↑ {} tokens", format_tokens_compact(tokens_up))
    } else {
        String::new()
    };
    let thought_part = if thought_ms > 0 {
        // Upstream's `thought for Xs` — seconds rounded. Matches
        // `components/AssistantThinkingBlock.tsx` chip copy.
        let secs = (thought_ms + 500) / 1000;
        format!(" · thought for {secs}s")
    } else {
        String::new()
    };
    format!("{frame} {verb}… ({elapsed_str}{tokens_part}{thought_part})")
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
    tokens_down: u64,
    thought_ms: u64,
    effort_label: Option<&str>,
) {
    let _ = effort_label; // upstream shows `thought for Xs` instead
    let frame = spinner_frame(tick);
    let elapsed_str = format_elapsed(elapsed);
    // ↓ once the assistant starts emitting, ↑ before that. Never
    // both at once — transitions from upload-wait to
    // response-streaming as the turn progresses.
    let tokens_part = if tokens_down > 0 {
        format!(" · ↓ {} tokens", format_tokens_compact(tokens_down))
    } else if tokens_up > 0 {
        format!(" · ↑ {} tokens", format_tokens_compact(tokens_up))
    } else {
        String::new()
    };
    let thought_part = if thought_ms > 0 {
        let secs = (thought_ms + 500) / 1000;
        format!(" · thought for {secs}s")
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
            format!("({elapsed_str}{tokens_part}{thought_part})"),
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
    fn spinner_cycles_through_star_frames() {
        // Forward-then-reverse star family matches upstream darwin
        // `getDefaultCharacters()` +  its reverse. Walk the cycle at
        // stride=ratio so each assertion covers one distinct frame —
        // the pulse breathes small → big → small.
        let ratio = SPINNER_FRAME_RATIO as u64;
        let expected = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
        for (i, &c) in expected.iter().enumerate() {
            assert_eq!(spinner_frame(ratio * i as u64), c, "frame {i}");
        }
        // Wrap-around: frame 12 lands back on the first glyph.
        assert_eq!(spinner_frame(ratio * 12), '·');
    }

    #[test]
    fn spinner_holds_frame_between_ticks() {
        // Within a single `SPINNER_FRAME_RATIO` window, consecutive
        // ticks should render the SAME frame — that's the whole
        // point of the ratio: slow the visible rotation without
        // dropping event-loop fps.
        let ratio = SPINNER_FRAME_RATIO as u64;
        for i in 0..ratio {
            assert_eq!(spinner_frame(i), '·');
        }
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
    fn format_progress_upload_phase_shows_up_arrow() {
        // Before any output tokens arrive, surface the ↑ input count
        // so the user knows the request is inflight.
        let text = format_progress_text(
            0,
            "Concocting",
            Duration::from_secs(760), // 12m 40s
            8_873,                    // renders as 8.9k
            0,
            0,
            None,
        );
        assert!(text.contains("12m 40s"), "elapsed: {text}");
        assert!(text.contains("↑ 8.9k tokens"), "up phase: {text}");
        assert!(!text.contains("↓"), "must not show down before output: {text}");
    }

    #[test]
    fn format_progress_streaming_phase_transitions_to_down_arrow() {
        // Once output tokens start flowing, the progress line switches
        // to ↓ — upstream never shows both at once.
        let text = format_progress_text(
            0,
            "Vibing",
            Duration::from_secs(65),
            8_873, // still has input count available
            383,   // ↓ 383 tokens now
            0,
            None,
        );
        assert!(text.contains("↓ 383 tokens"), "down phase: {text}");
        assert!(!text.contains("↑"), "must drop up once down arrives: {text}");
    }

    #[test]
    fn format_progress_omits_tokens_when_zero() {
        let text = format_progress_text(0, "Cogitating", Duration::from_secs(3), 0, 0, 0, None);
        assert!(text.contains("3s"));
        assert!(!text.contains("↑"));
        assert!(!text.contains("↓"));
    }

    #[test]
    fn format_progress_uses_supplied_verb() {
        let text = format_progress_text(0, "Unwinding", Duration::from_secs(1), 0, 0, 0, None);
        assert!(text.contains("Unwinding"));
    }

    #[test]
    fn format_progress_no_effort_chip() {
        // Upstream shows `thought for Xs`, NOT an effort chip — we
        // dropped the effort segment in favor of parity.
        let text = format_progress_text(
            0,
            "Thinking",
            Duration::from_secs(1),
            0,
            0,
            0,
            Some("xhigh"),
        );
        assert!(!text.contains("effort"));
        assert!(!text.contains("xhigh"));
    }

    #[test]
    fn format_progress_shows_thought_time() {
        let text = format_progress_text(
            0,
            "Cogitating",
            Duration::from_secs(5),
            100,
            0,
            2_400, // 2.4s → rounds to 2s
            None,
        );
        assert!(text.contains("thought for 2s"), "rendered: {text}");
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
