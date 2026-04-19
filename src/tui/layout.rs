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
//!
//! # Popup takeover
//!
//! When the caller passes `popup_rows > 0`, the statusline + info +
//! bottom-pad rows are suppressed and a single `popup` slot of exactly
//! `popup_rows` rows is reserved directly below the prompt bar. This
//! mirrors the reference TUI where the slash autocomplete overlays
//! the bottom chrome entirely while suggestions are visible. Streaming
//! area shrinks accordingly; chrome returns the next frame.

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
    /// Queued-message rows — one per queued entry, painted between
    /// the tip line and the prompt top-pad. `None` when empty or idle.
    /// Mirrors upstream's dim `> <message>` lines that sit directly
    /// below the thinking block while the turn is in flight.
    pub queue: Option<Rect>,
    /// Bordered prompt bar with `>` arrow.
    pub prompt: Rect,
    /// Slash-autocomplete popup slot — sits directly below the prompt
    /// bar when the caller requests a non-zero `popup_rows`, mirroring
    /// the reference TUI where suggestions render below the `/`
    /// input rather than floating above the log. `None` when no popup
    /// is active. Streaming area shrinks by `popup_rows` to open the
    /// space.
    pub popup: Option<Rect>,
    /// Statusline row (one above the info row).
    pub statusline: Rect,
    /// Info row — absolute bottom.
    pub info: Rect,
}

/// Upper bound on queued MESSAGE rows rendered on-screen. Anything
/// past this is summarized in the last visible row. 5 matches
/// upstream's observed soft cap — the prompt queue rarely exceeds it
/// and letting it grow unbounded would squeeze the streaming area.
pub const QUEUE_ROWS_CAP: u16 = 5;

/// Fixed overhead rows around the queued-message block: 1 row
/// margin-top (separates from thinking/tip) + 1 row hint below
/// (`↑ Press up to edit queued messages`). The message rows are
/// additive on top of this.
pub const QUEUE_CHROME_ROWS: u16 = 2;

/// Split `area` into bottom-up slots per C44/C51.
///
/// - `streaming_active` toggles the progress + tip rows between
///   visible and collapsed.
/// - `queue_count` grows a queue-slot between the tip line and the
///   prompt top-pad so upstream's queued messages render as
///   user-style rows above the prompt with a margin-top + hint row.
///   Message rows capped at [`QUEUE_ROWS_CAP`]; total slot height is
///   `visible_messages + QUEUE_CHROME_ROWS`. Counts above the cap
///   still render the cap rows (renderer summarizes overflow in-line).
/// - `popup_rows > 0` triggers popup takeover: the statusline, info
///   row, and bottom pad are all suppressed (height 0) and a single
///   `popup` slot of exactly `popup_rows` rows sits directly below
///   the prompt bar. Mirrors the reference TUI — while slash
///   autocomplete is open, the bottom chrome disappears and the
///   popup fills that strip.
pub fn split_frame(
    area: Rect,
    streaming_active: bool,
    queue_count: usize,
    popup_rows: u16,
) -> FrameSlots {
    // Display order (top → bottom):
    //   streaming (Min), [progress (1)], [tip (1)],
    //   [queue (margin-top + N messages + hint)],
    //   prompt top-pad (1), prompt (3),
    //   [popup (N) OR statusline (1), info (1), bottom pad (1)]
    //
    // prompt top-pad is an always-on 1-row gap so the last streaming
    // line / tip never hugs the prompt bar. The queue slot sits above
    // that top-pad with its own margin-top so the queued message reads
    // as a sibling of the prompt — matches the reference TUI's
    // queued-bubble placement.
    let message_rows: u16 = (queue_count as u16)
        .min(QUEUE_ROWS_CAP)
        .saturating_mul(u16::from(streaming_active));
    let queue_rows: u16 = if message_rows > 0 {
        message_rows + QUEUE_CHROME_ROWS
    } else {
        0
    };

    let popup_active = popup_rows > 0;

    let mut constraints: Vec<Constraint> = vec![Constraint::Min(1)];
    if streaming_active {
        constraints.push(Constraint::Length(1)); // progress top-pad
        constraints.push(Constraint::Length(1)); // progress
        constraints.push(Constraint::Length(1)); // tip
    }
    if queue_rows > 0 {
        constraints.push(Constraint::Length(queue_rows)); // queue
    }
    constraints.push(Constraint::Length(1)); // prompt top-pad (always)
    constraints.push(Constraint::Length(3)); // prompt bar
    if popup_active {
        constraints.push(Constraint::Length(popup_rows)); // popup
    } else {
        constraints.push(Constraint::Length(1)); // statusline
        constraints.push(Constraint::Length(1)); // info
        constraints.push(Constraint::Length(1)); // bottom pad
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);

    let streaming = chunks[0];
    let (progress, tip, after_tip_idx) = if streaming_active {
        (Some(chunks[2]), Some(chunks[3]), 4)
    } else {
        (None, None, 1)
    };
    let (queue, prompt_idx) = if queue_rows > 0 {
        (Some(chunks[after_tip_idx]), after_tip_idx + 2)
    } else {
        (None, after_tip_idx + 1)
    };
    let prompt = chunks[prompt_idx];

    let (popup, statusline, info) = if popup_active {
        (Some(chunks[prompt_idx + 1]), Rect::default(), Rect::default())
    } else {
        (
            None,
            pad_sides(chunks[prompt_idx + 1], 2),
            pad_sides(chunks[prompt_idx + 2], 2),
        )
    };

    FrameSlots {
        streaming,
        progress,
        tip,
        queue,
        prompt,
        popup,
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
        let slots = split_frame(area(20), false, 0, 0);
        assert!(slots.progress.is_none());
        assert!(slots.tip.is_none());
        assert!(slots.queue.is_none());
        assert_eq!(slots.info.y, 18);
        assert_eq!(slots.statusline.y, 17);
    }

    #[test]
    fn streaming_layout_includes_progress_and_tip() {
        let slots = split_frame(area(20), true, 0, 0);
        assert!(slots.progress.is_some());
        assert!(slots.tip.is_some());
        assert!(slots.queue.is_none());
        assert_eq!(slots.info.y, 18);
        assert_eq!(slots.statusline.y, 17);
        assert_eq!(slots.prompt.y, 14);
        assert_eq!(slots.tip.unwrap().y, 12);
        assert_eq!(slots.progress.unwrap().y, 11);
    }

    #[test]
    fn chrome_rows_have_lateral_padding() {
        let slots = split_frame(Rect::new(0, 0, 100, 20), false, 0, 0);
        assert_eq!(slots.statusline.x, 2);
        assert_eq!(slots.statusline.width, 96);
        assert_eq!(slots.info.x, 2);
        assert_eq!(slots.info.width, 96);
    }

    #[test]
    fn prompt_bar_always_three_rows() {
        let slots = split_frame(area(30), false, 0, 0);
        assert_eq!(slots.prompt.height, 3);
        let slots = split_frame(area(30), true, 0, 0);
        assert_eq!(slots.prompt.height, 3);
    }

    #[test]
    fn streaming_area_flexes_to_remaining_height() {
        let h_idle = split_frame(area(20), false, 0, 0).streaming.height;
        let h_stream = split_frame(area(20), true, 0, 0).streaming.height;
        assert!(h_idle >= h_stream);
        assert_eq!(h_idle - h_stream, 3);
    }

    #[test]
    fn prompt_top_pad_always_reserved() {
        let slots = split_frame(area(20), false, 0, 0);
        assert_eq!(slots.prompt.y, 14);
        assert_eq!(slots.streaming.height + 1, slots.prompt.y);
    }

    #[test]
    fn queue_slot_absent_when_idle_even_with_queue() {
        let slots = split_frame(area(30), false, 3, 0);
        assert!(slots.queue.is_none());
    }

    #[test]
    fn queue_slot_grows_with_queue_count() {
        let s1 = split_frame(area(30), true, 1, 0);
        let s2 = split_frame(area(30), true, 3, 0);
        assert_eq!(s1.queue.unwrap().height, 1 + QUEUE_CHROME_ROWS);
        assert_eq!(s2.queue.unwrap().height, 3 + QUEUE_CHROME_ROWS);
        assert!(s1.streaming.height > s2.streaming.height);
    }

    #[test]
    fn queue_message_rows_cap_at_five() {
        let slots = split_frame(area(40), true, 12, 0);
        assert_eq!(
            slots.queue.unwrap().height,
            QUEUE_ROWS_CAP + QUEUE_CHROME_ROWS
        );
    }

    #[test]
    fn queue_slot_sits_directly_above_prompt_top_pad() {
        let slots = split_frame(area(30), true, 2, 0);
        let queue = slots.queue.unwrap();
        assert_eq!(queue.y + queue.height + 1, slots.prompt.y);
    }

    #[test]
    fn popup_takeover_suppresses_chrome() {
        // With popup_rows > 0 the statusline + info + bottom pad
        // collapse to zero height and slots.popup carries the reserved
        // strip. This is the upstream-parity behavior: while slash
        // autocomplete is open, the bottom chrome disappears entirely.
        let slots = split_frame(area(20), false, 0, 5);
        assert!(slots.popup.is_some());
        assert_eq!(slots.statusline.height, 0);
        assert_eq!(slots.info.height, 0);
    }

    #[test]
    fn popup_sits_directly_below_prompt() {
        let slots = split_frame(area(20), false, 0, 4);
        let popup = slots.popup.unwrap();
        assert_eq!(popup.y, slots.prompt.y + slots.prompt.height);
        assert_eq!(popup.height, 4);
    }

    #[test]
    fn popup_idle_no_popup() {
        let slots = split_frame(area(20), false, 0, 0);
        assert!(slots.popup.is_none());
    }
}
