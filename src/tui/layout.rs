

use ratatui::layout::{Constraint, Direction, Layout, Rect};

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

pub struct FrameSlots {

    pub streaming: Rect,

    pub progress: Option<Rect>,

    pub tip: Option<Rect>,

    pub queue: Option<Rect>,

    pub prompt: Rect,

    pub popup: Option<Rect>,

    pub statusline: Rect,

    pub info: Rect,
}

pub const QUEUE_CHROME_ROWS: u16 = 1;

pub fn split_frame(
    area: Rect,
    streaming_active: bool,
    queue_count: usize,
    popup_rows: u16,
) -> FrameSlots {

    // Upstream only caps user-typed queued messages in task-notification mode
    // (PromptInputQueuedCommands.tsx:40). For regular queued input there is no
    // cap, so we render every entry — the terminal height bounds it anyway.
    let message_rows: u16 = (queue_count as u16)
        .saturating_mul(u16::from(streaming_active));
    let queue_rows: u16 = if message_rows > 0 {
        message_rows + QUEUE_CHROME_ROWS
    } else {
        0
    };

    let popup_active = popup_rows > 0;

    let mut constraints: Vec<Constraint> = vec![Constraint::Min(1)];
    if streaming_active {
        constraints.push(Constraint::Length(1));
        constraints.push(Constraint::Length(1));
        constraints.push(Constraint::Length(1));
    }
    if queue_rows > 0 {
        constraints.push(Constraint::Length(queue_rows));
    }
    constraints.push(Constraint::Length(1));
    constraints.push(Constraint::Length(3));
    if popup_active {
        constraints.push(Constraint::Length(popup_rows));
        // Bottom padding row: keep the last suggestion from kissing the
        // terminal edge (user report 2026-04-23: `/dre…` popup glued to
        // bottom). Reserved here instead of shrinking the inner list area,
        // which would clip a visible suggestion when popup_rows equals the
        // match count.
        constraints.push(Constraint::Length(1));
    } else {
        constraints.push(Constraint::Length(1));
        constraints.push(Constraint::Length(1));
        constraints.push(Constraint::Length(1));
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
    fn queue_slot_grows_uncapped_for_user_messages() {
        let slots = split_frame(area(40), true, 12, 0);
        assert_eq!(slots.queue.unwrap().height, 12 + QUEUE_CHROME_ROWS);
    }

    #[test]
    fn queue_slot_sits_directly_above_prompt_top_pad() {
        let slots = split_frame(area(30), true, 2, 0);
        let queue = slots.queue.unwrap();
        assert_eq!(queue.y + queue.height + 1, slots.prompt.y);
    }

    #[test]
    fn popup_takeover_suppresses_chrome() {

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
