

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

const SPINNER_FRAMES: &[char] = &[
    '·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·',
];

const VERBS: &[&str] = &[
    "Accomplishing",
    "Actioning",
    "Actualizing",
    "Architecting",
    "Baking",
    "Beaming",
    "Beboppin'",
    "Befuddling",
    "Billowing",
    "Blanching",
    "Bloviating",
    "Boogieing",
    "Boondoggling",
    "Booping",
    "Bootstrapping",
    "Brewing",
    "Bunning",
    "Burrowing",
    "Calculating",
    "Canoodling",
    "Caramelizing",
    "Cascading",
    "Catapulting",
    "Cerebrating",
    "Channeling",
    "Channelling",
    "Choreographing",
    "Churning",
    "Clauding",
    "Coalescing",
    "Cogitating",
    "Combobulating",
    "Composing",
    "Computing",
    "Concocting",
    "Considering",
    "Contemplating",
    "Cooking",
    "Crafting",
    "Creating",
    "Crunching",
    "Crystallizing",
    "Cultivating",
    "Deciphering",
    "Deliberating",
    "Determining",
    "Dilly-dallying",
    "Discombobulating",
    "Doing",
    "Doodling",
    "Drizzling",
    "Ebbing",
    "Effecting",
    "Elucidating",
    "Embellishing",
    "Enchanting",
    "Envisioning",
    "Evaporating",
    "Fermenting",
    "Fiddle-faddling",
    "Finagling",
    "Flambéing",
    "Flibbertigibbeting",
    "Flowing",
    "Flummoxing",
    "Fluttering",
    "Forging",
    "Forming",
    "Frolicking",
    "Frosting",
    "Gallivanting",
    "Galloping",
    "Garnishing",
    "Generating",
    "Gesticulating",
    "Germinating",
    "Gitifying",
    "Grooving",
    "Gusting",
    "Harmonizing",
    "Hashing",
    "Hatching",
    "Herding",
    "Honking",
    "Hullaballooing",
    "Hyperspacing",
    "Ideating",
    "Imagining",
    "Improvising",
    "Incubating",
    "Inferring",
    "Infusing",
    "Ionizing",
    "Jitterbugging",
    "Julienning",
    "Kneading",
    "Leavening",
    "Levitating",
    "Lollygagging",
    "Manifesting",
    "Marinating",
    "Meandering",
    "Metamorphosing",
    "Misting",
    "Moonwalking",
    "Moseying",
    "Mulling",
    "Mustering",
    "Musing",
    "Nebulizing",
    "Nesting",
    "Newspapering",
    "Noodling",
    "Nucleating",
    "Orbiting",
    "Orchestrating",
    "Osmosing",
    "Perambulating",
    "Percolating",
    "Perusing",
    "Philosophising",
    "Photosynthesizing",
    "Pollinating",
    "Pondering",
    "Pontificating",
    "Pouncing",
    "Precipitating",
    "Prestidigitating",
    "Processing",
    "Proofing",
    "Propagating",
    "Puttering",
    "Puzzling",
    "Quantumizing",
    "Razzle-dazzling",
    "Razzmatazzing",
    "Recombobulating",
    "Reticulating",
    "Roosting",
    "Ruminating",
    "Sautéing",
    "Scampering",
    "Schlepping",
    "Scurrying",
    "Seasoning",
    "Shenaniganing",
    "Shimmying",
    "Simmering",
    "Skedaddling",
    "Sketching",
    "Slithering",
    "Smooshing",
    "Sock-hopping",
    "Spelunking",
    "Spinning",
    "Sprouting",
    "Stewing",
    "Sublimating",
    "Swirling",
    "Swooping",
    "Symbioting",
    "Synthesizing",
    "Tempering",
    "Thinking",
    "Thundering",
    "Tinkering",
    "Tomfoolering",
    "Topsy-turvying",
    "Transfiguring",
    "Transmuting",
    "Twisting",
    "Undulating",
    "Unfurling",
    "Unravelling",
    "Vibing",
    "Waddling",
    "Wandering",
    "Warping",
    "Whatchamacalliting",
    "Whirlpooling",
    "Whirring",
    "Whisking",
    "Wibbling",
    "Working",
    "Wrangling",
    "Zesting",
    "Zigzagging",
];

static TURN_SEED: AtomicU64 = AtomicU64::new(0);

pub fn next_turn_seed() -> u64 {
    TURN_SEED.fetch_add(1, Ordering::Relaxed)
}

pub fn pick_verb_for_turn(seed: u64) -> &'static str {
    VERBS[(seed as usize) % VERBS.len()]
}

pub fn spinner_frame(tick: u64) -> char {
    SPINNER_FRAMES[(tick as usize / SPINNER_FRAME_RATIO) % SPINNER_FRAMES.len()]
}

const SPINNER_FRAME_RATIO: usize = 3;

pub fn format_progress_text(
    tick: u64,
    verb: &str,
    elapsed: Duration,
    tokens_up: u64,
    tokens_down: u64,
    thought_ms: u64,
    effort_label: Option<&str>,
) -> String {
    let frame = spinner_frame(tick);
    let elapsed_str = format_elapsed(elapsed);

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
    } else if let Some(level) = effort_label {
        format!(" · thinking with {level} effort")
    } else {
        String::new()
    };
    format!("{frame} {verb}… ({elapsed_str}{tokens_part}{thought_part})")
}

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

pub fn format_tokens_compact(n: u64) -> String {
    if n < 1_000 {
        n.to_string()
    } else if n < 10_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        format!("{}k", n / 1_000)
    }
}

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
    let frame = spinner_frame(tick);
    let elapsed_str = format_elapsed(elapsed);

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
    } else if let Some(level) = effort_label {
        format!(" · thinking with {level} effort")
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

        let ratio = SPINNER_FRAME_RATIO as u64;
        let expected = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
        for (i, &c) in expected.iter().enumerate() {
            assert_eq!(spinner_frame(ratio * i as u64), c, "frame {i}");
        }

        assert_eq!(spinner_frame(ratio * 12), '·');
    }

    #[test]
    fn spinner_holds_frame_between_ticks() {

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

        let text = format_progress_text(
            0,
            "Concocting",
            Duration::from_secs(760),
            8_873,
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

        let text = format_progress_text(
            0,
            "Vibing",
            Duration::from_secs(65),
            8_873,
            383,
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
    fn format_progress_effort_chip_while_thinking() {

        let text = format_progress_text(
            0,
            "Thinking",
            Duration::from_secs(1),
            0,
            0,
            0,
            Some("xhigh"),
        );
        assert!(text.contains("thinking with xhigh effort"), "got: {text}");
    }

    #[test]
    fn format_progress_drops_effort_chip_once_thought_lands() {

        let text = format_progress_text(
            0,
            "Thinking",
            Duration::from_secs(1),
            0,
            0,
            1_200,
            Some("xhigh"),
        );
        assert!(text.contains("thought for 1s"), "got: {text}");
        assert!(!text.contains("thinking with"), "got: {text}");
    }

    #[test]
    fn format_progress_shows_thought_time() {
        let text = format_progress_text(
            0,
            "Cogitating",
            Duration::from_secs(5),
            100,
            0,
            2_400,
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
