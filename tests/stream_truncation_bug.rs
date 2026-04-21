

use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Wrap};

#[test]
fn paragraph_wrap_expands_logical_lines_past_logical_count() {

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

    assert!(visual > logical, "visual MUST exceed logical when wrapping");
}

#[test]
fn streaming_tail_lands_in_visual_overflow_while_logical_fits() {

    let buffer = "Here is a streaming assistant response. ".repeat(30);
    let lines = vec![Line::raw(buffer)];
    let para = Paragraph::new(lines).wrap(Wrap { trim: false });

    let logical = 1u16;
    let visual = para.line_count(60) as u16;

    let inner_h = 10u16;

    assert!(
        logical <= inner_h,
        "logical fits inner_h → current code takes the CLIP branch"
    );
    assert!(
        visual > inner_h,
        "visual overflows inner_h — text would be clipped under current logic"
    );
}
