//! Markdown → `ratatui::text::Line` converter for assistant messages.
//!
//! Event-stream based (pulldown-cmark) so we own the style mapping
//! end-to-end. Not a full HTML renderer — just the subset the model
//! typically emits: paragraphs, headings, emphasis, inline code,
//! fenced code blocks, block quotes, ordered/unordered lists.
//!
//! Upstream parity: heading markers (`# `, `## `, …) are stripped from
//! the rendered spans, inline code loses its literal backticks (the
//! styled pill carries the code visually), and common prompt XML tags
//! (`<system-reminder>…</system-reminder>`, `<env>…</env>`,
//! `<local-command-stdout>…</local-command-stdout>`) are stripped
//! before the parser sees them — mirrors `stripPromptXMLTags` in the
//! upstream harness so a tag that leaks into the assistant response
//! never renders raw.
//!
//! Unsupported constructs (tables, images, footnotes) fall through to
//! their raw text — we never crash on unexpected markdown.

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::render::theme;

/// Common prompt XML tags that the upstream harness strips before
/// markdown parsing. Kept narrow — only tags that routinely leak into
/// the assistant channel as raw text; adding a tag here means it will
/// vanish from the rendered transcript entirely, so the list stays
/// conservative.
const STRIPPED_XML_TAGS: &[&str] = &[
    "system-reminder",
    "env",
    "local-command-stdout",
    "local-command-stderr",
    "command-message",
    "command-name",
    "command-args",
];

/// Strip well-known prompt XML blocks before the markdown parser sees
/// them. Each tag pair (`<tag>…</tag>`) is removed non-greedily. Tags
/// outside [`STRIPPED_XML_TAGS`] pass through untouched so regular
/// inline XML the model might emit (e.g. code samples demonstrating
/// HTML) still renders. Mirrors upstream `stripPromptXMLTags`.
pub fn strip_prompt_xml_tags(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let bytes = src.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some(after_open) = find_open_tag(&src[i..]) {
                let tag_name = &src[i + 1..i + after_open - 1];
                if STRIPPED_XML_TAGS.iter().any(|t| t.eq_ignore_ascii_case(tag_name)) {
                    // Locate the matching close — case-insensitive.
                    let close_marker = format!("</{}>", tag_name);
                    let rest = &src[i + after_open..];
                    if let Some(close_rel) = find_close_tag_ci(rest, &close_marker) {
                        i += after_open + close_rel + close_marker.len();
                        continue;
                    }
                    // Unmatched open tag — bail out conservatively:
                    // drop the rest so the raw reminder text doesn't
                    // leak into the transcript.
                    break;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Find the byte index one past the closing `>` of a simple open tag
/// starting at `s[0] == '<'`. Returns `None` when the run doesn't look
/// like `<identifier[ ...]>`.
fn find_open_tag(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'<') {
        return None;
    }
    // `<identifier[ attrs...]>` — name can contain ASCII letters, digits, `-`.
    let mut j = 1;
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-') {
        j += 1;
    }
    if j == 1 {
        return None;
    }
    // Skip optional attribute run up to `>`.
    while j < bytes.len() && bytes[j] != b'>' {
        j += 1;
    }
    if j >= bytes.len() {
        return None;
    }
    Some(j + 1)
}

/// Case-insensitive search for `needle` inside `hay`, returning the
/// byte offset of the match. Needed because close tags in the wild
/// sometimes mismatch case.
fn find_close_tag_ci(hay: &str, needle: &str) -> Option<usize> {
    let hay_lc = hay.to_ascii_lowercase();
    let needle_lc = needle.to_ascii_lowercase();
    hay_lc.find(&needle_lc)
}

/// Convert a markdown source string into styled `Line`s.
///
/// Blocks are separated by a single blank line. Code blocks get a
/// left-gutter `│` and a dim background. Block quotes get `▌ `.
/// Lists get `• ` (unordered) or `N. ` (ordered) prefixes.
pub fn render(src: &str) -> Vec<Line<'static>> {
    let cleaned = strip_prompt_xml_tags(src);
    let parser = Parser::new(&cleaned);
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
                    // Upstream strips the `#` / `##` / `###` markers
                    // and conveys heading level through style alone.
                    // H1 = bold + PRIMARY; H2 = bold default text;
                    // H3 = italic default text; H4+ = plain default
                    // — a subtle hierarchy that reads without the
                    // markdown-source noise.
                    let style = match level {
                        HeadingLevel::H1 => Style::default()
                            .fg(theme::PRIMARY)
                            .add_modifier(Modifier::BOLD),
                        HeadingLevel::H2 => Style::default()
                            .fg(theme::TEXT)
                            .add_modifier(Modifier::BOLD),
                        HeadingLevel::H3 => Style::default()
                            .fg(theme::TEXT)
                            .add_modifier(Modifier::ITALIC),
                        _ => Style::default().fg(theme::TEXT),
                    };
                    push_style(&mut style_stack, style);
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
                // Upstream renders inline code as a styled pill WITHOUT
                // the literal backtick markers — the background + color
                // combination carries the "this is code" signal.
                current_spans.push(Span::styled(
                    t.to_string(),
                    Style::default()
                        .fg(theme::SUGGESTION)
                        .bg(theme::SUBTLE),
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
    fn heading_has_no_literal_hash() {
        // Upstream parity — `#` marker is stripped; only the styled
        // title text lands in the rendered spans.
        let lines = render("# Title");
        let text: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(!text.contains('#'), "heading span leaked `#`: {text:?}");
        assert!(text.contains("Title"));
    }

    #[test]
    fn heading_level_two_has_no_literal_hash() {
        let lines = render("## Section");
        let text: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(!text.contains('#'), "h2 span leaked `#`: {text:?}");
        assert!(text.contains("Section"));
    }

    #[test]
    fn heading_level_three_has_no_literal_hash() {
        let lines = render("### Sub");
        let text: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(!text.contains('#'), "h3 span leaked `#`: {text:?}");
        assert!(text.contains("Sub"));
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
    fn inline_code_has_no_literal_backticks() {
        // Upstream parity — the styled pill conveys "code" without
        // dragging the backtick markers into the visible output.
        let lines = render("use `foo` here");
        let text: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert!(!text.contains('`'), "inline code leaked backtick: {text:?}");
        assert!(text.contains("foo"));
        assert!(text.contains("use "));
        assert!(text.contains(" here"));
    }

    #[test]
    fn strip_prompt_xml_removes_system_reminder() {
        let src = "foo <system-reminder>secret</system-reminder> bar";
        let lines = render(src);
        let text: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.as_ref()))
            .collect();
        assert!(
            !text.contains("system-reminder"),
            "rendered output leaked tag: {text:?}"
        );
        assert!(
            !text.contains("secret"),
            "rendered output leaked stripped body: {text:?}"
        );
        assert!(text.contains("foo"));
        assert!(text.contains("bar"));
    }

    #[test]
    fn strip_prompt_xml_removes_env_block() {
        let src = "before <env>cwd: /tmp</env> after";
        let out = strip_prompt_xml_tags(src);
        assert!(!out.contains("<env>"));
        assert!(!out.contains("cwd:"));
        assert!(out.contains("before"));
        assert!(out.contains("after"));
    }

    #[test]
    fn strip_prompt_xml_preserves_unknown_tags() {
        // An `<info>` tag is not on the strip list — the renderer
        // should pass it through untouched so the model can still
        // emit example HTML in its replies without losing content.
        let src = "<info>keep me</info>";
        let out = strip_prompt_xml_tags(src);
        assert_eq!(out, src);
    }

    #[test]
    fn strip_prompt_xml_handles_multiline_block() {
        let src = "head <system-reminder>\nline a\nline b\n</system-reminder> tail";
        let out = strip_prompt_xml_tags(src);
        assert!(!out.contains("line a"));
        assert!(!out.contains("line b"));
        assert!(out.contains("head"));
        assert!(out.contains("tail"));
    }
}
