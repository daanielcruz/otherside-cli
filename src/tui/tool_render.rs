//! Tool-call render path — `⏺ <ToolName>  ⎿ <status|preview>`.
//!
//! Called by the streaming log when a finalized `DisplayMessage` of
//! role `Tool` arrives (or, once the 005 agent loop lands, when a live
//! tool-use block is in flight).
//!
//! The TODO wire: the streaming path currently passes role-`Tool`
//! content through `render_message`. Replace that branch with
//! `tool_render::render_tool_call` once the `DisplayMessage` shape
//! carries structured tool-use fields (name, input, result). For now
//! this module works against a loose `ToolCallView` that the caller
//! constructs.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::render::theme;
use super::{diff, todos};

/// Per-tool bullet glyph. Upstream uses darwin-specific `⏺` and `●`
/// elsewhere; we use the same so font fallback matches.
#[cfg(target_os = "macos")]
const BULLET: &str = "⏺";
#[cfg(not(target_os = "macos"))]
const BULLET: &str = "●";

/// Tool call status. Drives the badge color on the bullet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Ok,
    Error,
}

impl ToolStatus {
    fn color(self) -> ratatui::style::Color {
        match self {
            // 011 fidelity: gray-blinking bullet during dispatch,
            // solid green on tool_result, solid red on error. Matches
            // upstream's semantic color assignment (palette differs
            // deliberately — only roles line up).
            ToolStatus::Running => theme::MUTED,
            ToolStatus::Ok => theme::SUCCESS,
            ToolStatus::Error => theme::ERROR,
        }
    }

    /// Extra text modifiers layered on top of the color. `Running`
    /// gets `SLOW_BLINK` so the bullet pulses while the tool hasn't
    /// returned; `Ok` / `Error` render solid.
    fn modifier(self) -> ratatui::style::Modifier {
        use ratatui::style::Modifier;
        match self {
            ToolStatus::Running => Modifier::BOLD | Modifier::SLOW_BLINK,
            ToolStatus::Ok | ToolStatus::Error => Modifier::BOLD,
        }
    }
}

/// Opaque payload attached to a tool call so the render path can pick
/// a specialized sub-renderer (todos, diff, plain text) without
/// parsing the JSON twice.
pub enum ToolPayload {
    /// Raw text preview (first N chars of stdout / first line of the
    /// result JSON).
    Preview(String),
    /// TodoWrite items — render with the todos module.
    Todos(Vec<todos::TodoItem>),
    /// Edit/Write unified diff — render with the diff module.
    Diff(String),
}

/// Compact view the caller hands this module.
pub struct ToolCallView<'a> {
    pub name: &'a str,
    pub status: ToolStatus,
    pub elapsed_ms: Option<u64>,
    pub payload: Option<&'a ToolPayload>,
}

/// Render a single tool call into owned Lines ready to splice into
/// the streaming log.
pub fn render_tool_call(view: &ToolCallView<'_>) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();

    // Header row: `⏺ ToolName  (status · Xs)`
    let mut header_spans: Vec<Span<'static>> = Vec::with_capacity(4);
    header_spans.push(Span::styled(
        format!("{BULLET} "),
        Style::default()
            .fg(view.status.color())
            .add_modifier(view.status.modifier()),
    ));
    header_spans.push(Span::styled(
        view.name.to_string(),
        Style::default()
            .fg(theme::TEXT)
            .add_modifier(Modifier::BOLD),
    ));
    header_spans.push(Span::styled(
        format!("  ({}{})", status_text(view.status), elapsed_suffix(view.elapsed_ms)),
        Style::default().fg(theme::MUTED),
    ));
    out.push(Line::from(header_spans));

    // Payload — indented under the gutter glyph.
    if let Some(payload) = view.payload {
        match payload {
            ToolPayload::Preview(text) => {
                for raw in text.lines() {
                    out.push(Line::from(vec![
                        Span::styled(
                            "  ⎿ ".to_string(),
                            Style::default().fg(theme::MUTED),
                        ),
                        Span::styled(raw.to_string(), Style::default().fg(theme::MUTED)),
                    ]));
                }
            }
            ToolPayload::Todos(items) => {
                let rendered = todos::render_lines(items);
                for l in rendered {
                    // Add left gutter for visual consistency.
                    let mut spans: Vec<Span<'static>> = Vec::with_capacity(l.spans.len() + 1);
                    spans.push(Span::styled(
                        "  ⎿ ".to_string(),
                        Style::default().fg(theme::MUTED),
                    ));
                    spans.extend(l.spans);
                    out.push(Line::from(spans));
                }
            }
            ToolPayload::Diff(fragment) => {
                let rendered = diff::render_unified(fragment);
                for l in rendered {
                    let mut spans: Vec<Span<'static>> = Vec::with_capacity(l.spans.len() + 1);
                    spans.push(Span::styled(
                        "  ⎿ ".to_string(),
                        Style::default().fg(theme::MUTED),
                    ));
                    spans.extend(l.spans);
                    out.push(Line::from(spans));
                }
            }
        }
    }

    out
}

fn status_text(s: ToolStatus) -> &'static str {
    match s {
        ToolStatus::Running => "running",
        ToolStatus::Ok => "ok",
        ToolStatus::Error => "error",
    }
}

fn elapsed_suffix(ms: Option<u64>) -> String {
    match ms {
        Some(m) if m >= 1_000 => format!(" · {}s", m / 1_000),
        Some(m) => format!(" · {m}ms"),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::todos::{TodoItem, TodoStatus};

    fn collect_text(lines: &[Line<'static>]) -> String {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn header_contains_tool_name_and_status() {
        let view = ToolCallView {
            name: "Read",
            status: ToolStatus::Ok,
            elapsed_ms: Some(1500),
            payload: None,
        };
        let lines = render_tool_call(&view);
        let text = collect_text(&lines);
        assert!(text.contains("Read"));
        assert!(text.contains("ok"));
        assert!(text.contains("1s"));
    }

    #[test]
    fn preview_payload_renders_under_gutter() {
        let preview = ToolPayload::Preview("first line\nsecond line".into());
        let view = ToolCallView {
            name: "Glob",
            status: ToolStatus::Ok,
            elapsed_ms: None,
            payload: Some(&preview),
        };
        let lines = render_tool_call(&view);
        let text = collect_text(&lines);
        assert!(text.contains("⎿"));
        assert!(text.contains("first line"));
        assert!(text.contains("second line"));
    }

    #[test]
    fn todos_payload_renders_todos() {
        let items = vec![
            TodoItem {
                content: "task a".into(),
                status: TodoStatus::Pending,
                active_form: None,
            },
            TodoItem {
                content: "task b".into(),
                status: TodoStatus::Completed,
                active_form: None,
            },
        ];
        let payload = ToolPayload::Todos(items);
        let view = ToolCallView {
            name: "TodoWrite",
            status: ToolStatus::Ok,
            elapsed_ms: Some(12),
            payload: Some(&payload),
        };
        let lines = render_tool_call(&view);
        let text = collect_text(&lines);
        assert!(text.contains("TodoWrite"));
        assert!(text.contains("task a"));
        assert!(text.contains("task b"));
    }

    #[test]
    fn diff_payload_renders_diff() {
        let frag = "@@ -1 +1 @@\n-old\n+new";
        let payload = ToolPayload::Diff(frag.into());
        let view = ToolCallView {
            name: "Edit",
            status: ToolStatus::Ok,
            elapsed_ms: Some(4),
            payload: Some(&payload),
        };
        let lines = render_tool_call(&view);
        let text = collect_text(&lines);
        assert!(text.contains("Edit"));
        assert!(text.contains("old"));
        assert!(text.contains("new"));
    }
}
