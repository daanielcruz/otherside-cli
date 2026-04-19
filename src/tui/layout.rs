//! C44 bottom-up frame layout.
//!
//! Stack (top → bottom as it appears on screen):
//!
//! ```text
//! [streaming area] — flexes
//! [progress line] — 1 row, only while inference is live
//! [tip line] — 1 row, only while inference is live
//! [prompt top-pad] — 1 row, always (breathing room above prompt)
//! [prompt bar + `>` arrow] — 3 rows with borders
//! [statusline] — 1 row
//! [info row] — 1 row, absolute last row
//! ```
//!
//! When not streaming, progress + tip rows collapse and the streaming
//! area flexes down to fill them. The prompt top-pad ALWAYS renders
//! so the last message / tip line does not hug the prompt bar —
//! matches upstream ScrollBox which leaves vertical space above the
//! input band.
//!
//! Per C51, info row is the absolute last line, statusline sits one
//! row above it.

use ratatui::layout::{Constraint, Direction, Layout, Rect};

/// Shrink a rect by `pad` columns on each side — used to carve the
/// lateral margin upstream ships on the chrome band.
fn pad_sides(r: Rect, pad: u16) -> Rect {
    let total = pad.saturating_mul(2);
    if r.width <= total {
        return r;
    }
    Rect {
        x: r.x + pad,
        y: r.y,
        width: r.width - total,
        height: r.height,
    }
}

/// Composed rects for each region of the TUI frame.
pub struct FrameSlots {
    /// Scrollable streaming / conversation area.
    pub streaming: Rect,
    /// Progress line (spinner + elapsed + tokens). `None` when idle.
    pub progress: Option<Rect>,
    /// Tip line below progress. `None` when idle.
    pub tip: Option<Rect>,
    /// Bordered prompt bar with `>` arrow.
    pub prompt: Rect,
    /// Statusline row (one above the info row).
    pub statusline: Rect,
    /// Info row — absolute bottom.
    pub info: Rect,
}

/// Split `area` into bottom-up slots per C44/C51. `streaming_active`
/// toggles the progress + tip rows between visible and collapsed.
pub fn split_frame(area: Rect, streaming_active: bool) -> FrameSlots {
    // Display order (top → bottom):
    //   streaming (Min), [progress (1)], [tip (1)], prompt top-pad (1),
    //   prompt (3), statusline (1), info (1), bottom pad (1)
    //
    // prompt top-pad is an always-on 1-row gap so the last streaming
    // line / tip never hugs the prompt bar — mirrors upstream
    // ScrollBox spacing above the PromptInput band. Queued-message
    // area (future 017) will render INSIDE this gap to intentionally
    // sit close to the prompt — everything else respects it.
    let mut constraints: Vec<Constraint> = vec![Constraint::Min(1)];
    if streaming_active {
        constraints.push(Constraint::Length(1)); // progress top-pad
        constraints.push(Constraint::Length(1)); // progress
        constraints.push(Constraint::Length(1)); // tip
    }
    constraints.push(Constraint::Length(1)); // prompt top-pad (always)
    constraints.push(Constraint::Length(3)); // prompt bar
    constraints.push(Constraint::Length(1)); // statusline
    constraints.push(Constraint::Length(1)); // info
    constraints.push(Constraint::Length(1)); // bottom pad

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);

    let streaming = chunks[0];
    let (progress, tip, prompt_idx) = if streaming_active {
        // chunks[1] = progress top-pad (blank), chunks[2] = progress,
        // chunks[3] = tip, chunks[4] = prompt top-pad, chunks[5] = prompt.
        (Some(chunks[2]), Some(chunks[3]), 5)
    } else {
        (None, None, 2)
    };
    let prompt = chunks[prompt_idx];
    let statusline = pad_sides(chunks[prompt_idx + 1], 2);
    let info = pad_sides(chunks[prompt_idx + 2], 2);
    // chunks[prompt_idx + 3] = bottom pad, intentionally unused.

    FrameSlots {
        streaming,
        progress,
        tip,
        prompt,
        statusline,
        info,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(h: u16) -> Rect {
        Rect::new(0, 0, 80, h)
    }

    #[test]
    fn idle_layout_omits_progress_and_tip() {
        let slots = split_frame(area(20), false);
        assert!(slots.progress.is_none());
        assert!(slots.tip.is_none());
        // Bottom pad at row 19; info at 18; statusline at 17.
        assert_eq!(slots.info.y, 18);
        assert_eq!(slots.statusline.y, 17);
    }

    #[test]
    fn streaming_layout_includes_progress_and_tip() {
        let slots = split_frame(area(20), true);
        assert!(slots.progress.is_some());
        assert!(slots.tip.is_some());
        assert_eq!(slots.info.y, 18);
        assert_eq!(slots.statusline.y, 17);
        // Prompt sits above the statusline; one row of top-pad sits
        // between prompt and the tip line; another row of top-pad
        // sits between the streaming area and the progress spinner
        // so the last turn doesn't hug the thinking block.
        assert_eq!(slots.prompt.y, 14);
        // Row 13 is the always-on prompt top-pad (breathing room).
        assert_eq!(slots.tip.unwrap().y, 12);
        assert_eq!(slots.progress.unwrap().y, 11);
        // Row 10 is the progress top-pad.
    }

    #[test]
    fn chrome_rows_have_lateral_padding() {
        let slots = split_frame(Rect::new(0, 0, 100, 20), false);
        // pad_sides(2) eats 2 cols from each side of the 100-wide frame.
        assert_eq!(slots.statusline.x, 2);
        assert_eq!(slots.statusline.width, 96);
        assert_eq!(slots.info.x, 2);
        assert_eq!(slots.info.width, 96);
    }

    #[test]
    fn prompt_bar_always_three_rows() {
        let slots = split_frame(area(30), false);
        assert_eq!(slots.prompt.height, 3);
        let slots = split_frame(area(30), true);
        assert_eq!(slots.prompt.height, 3);
    }

    #[test]
    fn streaming_area_flexes_to_remaining_height() {
        let h_idle = split_frame(area(20), false).streaming.height;
        let h_stream = split_frame(area(20), true).streaming.height;
        // Idle recovers the 3 streaming-only rows (progress top-pad +
        // progress + tip); prompt top-pad is always reserved so it
        // cancels out of the delta.
        assert!(h_idle >= h_stream);
        assert_eq!(h_idle - h_stream, 3);
    }

    #[test]
    fn prompt_top_pad_always_reserved() {
        // Even when idle, there is a 1-row gap above the prompt bar
        // so the last assistant/user line never hugs the input.
        let slots = split_frame(area(20), false);
        // With 20 rows: info=18, statusline=17, prompt rows=14..16,
        // top-pad=13. Streaming area fills 0..12 inclusive (13 rows).
        assert_eq!(slots.prompt.y, 14);
        assert_eq!(slots.streaming.height + 1, slots.prompt.y);
    }
}
