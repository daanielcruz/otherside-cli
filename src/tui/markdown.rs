//! Markdown → `ratatui::text::Line` converter for assistant messages.
//!
//! Event-stream based (pulldown-cmark) so we own the style mapping
//! end-to-end. Not a full HTML renderer — just the subset the model
//! typically emits: paragraphs, headings, emphasis, inline code,
//! fenced code blocks, block quotes, ordered/unordered lists.
//!
//! Unsupported constructs (tables, images, footnotes) fall through to
//! their raw text — we never crash on unexpected markdown.

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::render::theme;

/// Convert a markdown source string into styled `Line`s.
///
/// Blocks are separated by a single blank line. Code blocks get a
/// left-gutter `│` and a dim background. Block quotes get `▌ `.
/// Lists get `• ` (unordered) or `N. ` (ordered) prefixes.
pub fn render(src: &str) -> Vec<Line<'static>> {
    let parser = Parser::new(src);
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut current_spans: Vec<Span<'static>> = Vec::new();
    let mut style_stack: Vec<Style> = vec![Style::default().fg(theme::TEXT)];
    let mut in_code_block = false;
    let mut list_counters: Vec<Option<u64>> = Vec::new();
    let mut in_block_quote = false;

    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    flush_line(&mut out, &mut current_spans);
                    let prefix = match level {
                        HeadingLevel::H1 => "# ",
                        HeadingLevel::H2 => "## ",
                        HeadingLevel::H3 => "### ",
                        _ => "#### ",
                    };
                    current_spans.push(Span::styled(
                        prefix.to_string(),
                        Style::default()
                            .fg(theme::PRIMARY)
                            .add_modifier(Modifier::BOLD),
                    ));
                    push_style(
                        &mut style_stack,
                        Style::default()
                            .fg(theme::TEXT)
                            .add_modifier(Modifier::BOLD),
                    );
                }
                Tag::Emphasis => push_mod(&mut style_stack, Modifier::ITALIC),
                Tag::Strong => push_mod(&mut style_stack, Modifier::BOLD),
                Tag::Strikethrough => push_mod(&mut style_stack, Modifier::CROSSED_OUT),
                Tag::CodeBlock(_) => {
                    flush_line(&mut out, &mut current_spans);
                    in_code_block = true;
                }
                Tag::BlockQuote(_) => {
                    in_block_quote = true;
                }
                Tag::List(start) => {
                    list_counters.push(start);
                }
                Tag::Item => {
                    flush_line(&mut out, &mut current_spans);
                    let prefix = match list_counters.last_mut() {
                        Some(Some(n)) => {
                            let out_prefix = format!("  {n}. ");
                            *n = n.wrapping_add(1);
                            out_prefix
                        }
                        Some(None) => "  • ".to_string(),
                        None => "  • ".to_string(),
                    };
                    current_spans.push(Span::styled(
                        prefix,
                        Style::default().fg(theme::MUTED),
                    ));
                }
                Tag::Paragraph => {}
                Tag::Link { dest_url, .. } => {
                    push_style(
                        &mut style_stack,
                        Style::default()
                            .fg(theme::SUGGESTION)
                            .add_modifier(Modifier::UNDERLINED),
                    );
                    let _ = dest_url;
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    flush_line(&mut out, &mut current_spans);
                    out.push(Line::raw(""));
                    pop_style(&mut style_stack);
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                    pop_style(&mut style_stack);
                }
                TagEnd::CodeBlock => {
                    flush_line(&mut out, &mut current_spans);
                    in_code_block = false;
                    out.push(Line::raw(""));
                }
                TagEnd::BlockQuote(_) => {
                    in_block_quote = false;
                    flush_line(&mut out, &mut current_spans);
                    out.push(Line::raw(""));
                }
                TagEnd::List(_) => {
                    list_counters.pop();
                    flush_line(&mut out, &mut current_spans);
                    out.push(Line::raw(""));
                }
                TagEnd::Item => {
                    flush_line(&mut out, &mut current_spans);
                }
                TagEnd::Paragraph => {
                    flush_line(&mut out, &mut current_spans);
                    out.push(Line::raw(""));
                }
                TagEnd::Link => pop_style(&mut style_stack),
                _ => {}
            },
            Event::Text(t) => {
                let base_style = *style_stack.last().unwrap_or(&Style::default());
                if in_code_block {
                    for line in t.split('\n') {
                        if !current_spans.is_empty() {
                            flush_line(&mut out, &mut current_spans);
                        }
                        current_spans.push(Span::styled(
                            "│ ".to_string(),
                            Style::default().fg(theme::SUBTLE),
                        ));
                        current_spans.push(Span::styled(
                            line.to_string(),
                            Style::default().fg(theme::SUGGESTION),
                        ));
                        flush_line(&mut out, &mut current_spans);
                    }
                } else if in_block_quote {
                    if current_spans.is_empty() {
                        current_spans.push(Span::styled(
                            "▌ ".to_string(),
                            Style::default().fg(theme::PRIMARY),
                        ));
                    }
                    current_spans.push(Span::styled(t.to_string(), base_style));
                } else {
                    current_spans.push(Span::styled(t.to_string(), base_style));
                }
            }
            Event::Code(t) => {
                current_spans.push(Span::styled(
                    format!("`{t}`"),
                    Style::default().fg(theme::SUGGESTION),
                ));
            }
            Event::SoftBreak => {
                current_spans.push(Span::styled(" ".to_string(), Style::default()));
            }
            Event::HardBreak => {
                flush_line(&mut out, &mut current_spans);
            }
            Event::Rule => {
                flush_line(&mut out, &mut current_spans);
                out.push(Line::from(Span::styled(
                    "─".repeat(40),
                    Style::default().fg(theme::SUBTLE),
                )));
            }
            _ => {}
        }
    }
    flush_line(&mut out, &mut current_spans);
    while matches!(out.last(), Some(l) if l.spans.is_empty()) {
        out.pop();
    }
    out
}

fn push_style(stack: &mut Vec<Style>, style: Style) {
    stack.push(style);
}

fn pop_style(stack: &mut Vec<Style>) {
    if stack.len() > 1 {
        stack.pop();
    }
}

fn push_mod(stack: &mut Vec<Style>, m: Modifier) {
    let cur = *stack.last().unwrap_or(&Style::default());
    stack.push(cur.add_modifier(m));
}

fn flush_line(out: &mut Vec<Line<'static>>, spans: &mut Vec<Span<'static>>) {
    if spans.is_empty() {
        return;
    }
    let line = Line::from(std::mem::take(spans));
    out.push(line);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paragraph_renders_one_line() {
        let lines = render("hello world");
        assert!(!lines.is_empty());
        let text: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert_eq!(text, "hello world");
    }

    #[test]
    fn heading_level_one_prefix() {
        let lines = render("# Title");
        let text: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(text.starts_with("# "));
        assert!(text.contains("Title"));
    }

    #[test]
    fn fenced_code_block_has_gutter() {
        let src = "```rust\nlet x = 1;\n```";
        let lines = render(src);
        let text: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(text.contains("│"));
        assert!(text.contains("let x = 1;"));
    }

    #[test]
    fn unordered_list_uses_bullet() {
        let lines = render("- one\n- two");
        let first: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(first.contains("•"));
        assert!(first.contains("one"));
    }

    #[test]
    fn ordered_list_uses_numbers() {
        let lines = render("1. alpha\n2. beta");
        let first: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(first.contains("1."));
        assert!(first.contains("alpha"));
    }

    #[test]
    fn inline_code_wrapped_in_backticks() {
        let lines = render("use `foo` here");
        let text: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(text.contains("`foo`"));
    }
}
