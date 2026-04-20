//! Repro for the stream-truncation bug flagged in roadmap.md Pillar 1.
//!
//! Symptom: while `streaming=true` the render path clips the tail of the
//! in-flight assistant buffer. The text only surfaces on the NEXT turn —
//! because adding more lines tips the render past the "fits entirely"
//! branch into the overflow branch that uses `para.scroll(...)`, which
//! handles wrapping correctly.
//!
//! Root cause: `draw_log` computes `total_lines = lines.len() as u16`
//! (LOGICAL lines) but renders through `Paragraph::wrap(...)` which
//! expands long lines into multiple VISUAL lines. When a logical line
//! wraps past the area width, `total_lines < visual_line_count`, so the
//! "fits entirely" sub-rect gets `height = total_lines`, which is less
//! than the visual height the paragraph actually wants. ratatui clips.
//!
//! Fix (to be landed): measure visual line count via
//! `Paragraph::line_count(width)` instead of `lines.len()`.

use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Wrap};

#[test]
fn paragraph_wrap_expands_logical_lines_past_logical_count() {
    // Single LOGICAL line, but 200 chars wide — at width 40 it wraps to
    // ~5 visual lines. If the caller uses `lines.len()` as the render
    // height, 4 of those visual lines get clipped.
    let long = "x".repeat(200);
    let lines = vec![Line::raw(long)];
    let para = Paragraph::new(lines).wrap(Wrap { trim: false });

    let logical = 1u16;
    let visual = para.line_count(40) as u16;

    assert_eq!(logical, 1, "one logical line");
    assert!(
        visual >= 5,
        "200 chars / 40 width should wrap to >=5 visual lines, got {visual}"
    );
    // This inequality IS the bug: the render path in tui/render.rs uses
    // `logical` to size the sub-rect, clipping `visual - logical` rows.
    assert!(visual > logical, "visual MUST exceed logical when wrapping");
}

#[test]
fn streaming_tail_lands_in_visual_overflow_while_logical_fits() {
    // Realistic scenario: assistant buffer ends mid-sentence on a long
    // paragraph. Logical line count = 1 (one paragraph, no blank break).
    // Visual wrapped count >> logical when width is narrow.
    let buffer = "Here is a streaming assistant response. ".repeat(30);
    let lines = vec![Line::raw(buffer)];
    let para = Paragraph::new(lines).wrap(Wrap { trim: false });

    let logical = 1u16;
    let visual = para.line_count(60) as u16;
    // inner_h simulating a small terminal height.
    let inner_h = 10u16;

    // Current logic: `if total_lines <= inner_h` takes the "fits"
    // branch, uses `height = total_lines = 1`. ratatui renders only
    // 1 row, clipping the other `visual - 1` rows of wrapped text.
    assert!(
        logical <= inner_h,
        "logical fits inner_h → current code takes the CLIP branch"
    );
    assert!(
        visual > inner_h,
        "visual overflows inner_h — text would be clipped under current logic"
    );
}
