//! Output truncation — cap combined stdout+stderr at `OUTPUT_CAP`
//! chars with a head/tail split so the model sees both the start and
//! the tail end of the process output.

use super::OUTPUT_CAP;

/// Truncation result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncatedOutput {
    pub output: String,
    pub was_truncated: bool,
    pub truncated_chars: usize,
}

/// Apply the cap. Uses char boundaries (not bytes) so UTF-8 glyphs
/// never get split mid-codepoint.
pub fn apply(s: &str) -> TruncatedOutput {
    apply_with_cap(s, OUTPUT_CAP)
}

/// Parameterized variant so tests can exercise boundary behavior
/// without allocating 30 000-char fixtures.
pub fn apply_with_cap(s: &str, cap: usize) -> TruncatedOutput {
    let total_chars = s.chars().count();
    if total_chars <= cap {
        return TruncatedOutput {
            output: s.to_string(),
            was_truncated: false,
            truncated_chars: 0,
        };
    }
    let head_chars = cap / 2;
    let tail_chars = cap - head_chars;
    let head: String = s.chars().take(head_chars).collect();
    let tail: String = s.chars().skip(total_chars - tail_chars).collect();
    let dropped = total_chars - cap;
    let banner = format!("\n[... truncated {dropped} chars ...]\n");
    TruncatedOutput {
        output: format!("{head}{banner}{tail}"),
        was_truncated: true,
        truncated_chars: dropped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_input_passes_through() {
        let t = apply_with_cap("hello", 100);
        assert_eq!(t.output, "hello");
        assert!(!t.was_truncated);
        assert_eq!(t.truncated_chars, 0);
    }

    #[test]
    fn exactly_at_cap_is_not_truncated() {
        let s: String = (0..100).map(|_| 'x').collect();
        let t = apply_with_cap(&s, 100);
        assert!(!t.was_truncated);
    }

    #[test]
    fn long_input_splits_head_and_tail() {
        let s: String = (0..200).map(|i| (b'a' + (i % 26) as u8) as char).collect();
        let t = apply_with_cap(&s, 100);
        assert!(t.was_truncated);
        assert_eq!(t.truncated_chars, 100);
        assert!(t.output.contains("truncated 100 chars"));
        // First chars preserved
        assert!(t.output.starts_with('a'));
        // Tail preserved — last original char is (200 - 1) % 26 → 'v'
        let last = s.chars().last().unwrap();
        assert!(t.output.ends_with(last));
    }

    #[test]
    fn utf8_boundaries_respected() {
        // A hundred "日" glyphs (3 bytes each) ≈ 300 bytes; char count 100.
        let s: String = (0..100).map(|_| '日').collect();
        let t = apply_with_cap(&s, 40);
        assert!(t.was_truncated);
        // Must parse as valid UTF-8 — split_at_char logic would panic on bytes.
        assert!(t.output.chars().count() <= 40 + t.output.len() / 3);
    }
}
