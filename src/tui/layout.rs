//! C44 bottom-up frame layout.
//!
//! Stack (top → bottom as it appears on screen):
//!
//! ```
//! [streaming area] — flexes
//! [prompt bar + `>` arrow] — 3 rows with borders
//! [progress line] — 1 row, only while inference is live
//! [tip line] — 1 row, only while inference is live
//! [statusline] — 1 row
//! [info row] — 1 row, absolute last row
//! ```
//!
//! When not streaming, progress + tip rows collapse and the streaming
//! area flexes down to fill them.
//!
//! Per C51, info row is the absolute last line, statusline sits one
//! row above it.

use ratatui::layout::{Constraint, Direction, Layout, Rect};

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
    // Build constraints bottom-up but apply top-down (ratatui doesn't
    // have a bottom-up mode; we compose constraints in display order).
    //
    // Display order (top → bottom):
    //   streaming (Min), prompt (Length 3), [progress (Length 1)],
    //   [tip (Length 1)], statusline (Length 1), info (Length 1)
    let mut constraints: Vec<Constraint> = vec![Constraint::Min(1)]; // streaming
    constraints.push(Constraint::Length(3)); // prompt bar
    if streaming_active {
        constraints.push(Constraint::Length(1)); // progress
        constraints.push(Constraint::Length(1)); // tip
    }
    constraints.push(Constraint::Length(1)); // statusline
    constraints.push(Constraint::Length(1)); // info

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);

    // Unpack positionally so indices stay stable across the two
    // active/inactive shapes.
    let streaming = chunks[0];
    let prompt = chunks[1];
    let (progress, tip, statusline_idx) = if streaming_active {
        (Some(chunks[2]), Some(chunks[3]), 4)
    } else {
        (None, None, 2)
    };
    let statusline = chunks[statusline_idx];
    let info = chunks[statusline_idx + 1];

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
        assert_eq!(slots.info.y, 19, "info at absolute last row");
        assert_eq!(slots.statusline.y, 18, "statusline one above info");
    }

    #[test]
    fn streaming_layout_includes_progress_and_tip() {
        let slots = split_frame(area(20), true);
        assert!(slots.progress.is_some());
        assert!(slots.tip.is_some());
        assert_eq!(slots.info.y, 19);
        assert_eq!(slots.statusline.y, 18);
        // Tip sits above statusline when active.
        assert_eq!(slots.tip.unwrap().y, 17);
        assert_eq!(slots.progress.unwrap().y, 16);
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
        // Idle recovers the progress + tip rows.
        assert!(h_idle >= h_stream);
        assert_eq!(h_idle - h_stream, 2);
    }
}
