//! Tool-call render path — `⏺ <ToolName>  ⎿ <status|preview>`.
//!
//! 015 wires this module into the streaming log. `run_agent_turns`
//! emits typed `StreamEvent::ToolCallStart` / `ToolCallFinish` events;
//! `ConversationState` routes them into `active_tool_calls`; the log
//! painter iterates that vector each frame and calls
//! [`render_tool_call`] for every in-flight / finalized entry.
//!
//! The `Running` bullet renders in `theme::MUTED` with `SLOW_BLINK`
//! (terminal-native `ESC[5m`) so the status reads as animated until
//! the dispatch returns. `Ok` transitions to solid `theme::SUCCESS`,
//! `Error` to solid `theme::ERROR`.
//!
//! [`payload_from_result`] picks a specialized sub-renderer based on
//! tool name + result shape — Todos for TodoWrite, Diff for Edit/Write
//! when a unified-diff string is surfaced, Preview for everything else.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;

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
    /// Bullet color per status. Made `pub(crate)` in 015 so the
    /// outer render module can spot-check the wired transition in
    /// integration tests without reaching through the `Style`.
    pub(crate) fn color(self) -> ratatui::style::Color {
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
    pub(crate) fn modifier(self) -> ratatui::style::Modifier {
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
#[derive(Debug, Clone)]
pub enum ToolPayload {
    /// Raw text preview (first N chars of stdout / first line of the
    /// result JSON). Also used to surface a tool-dispatch error
    /// string — the render path paints previews in MUTED, which reads
    /// as muted-error under the ERROR-styled bullet without needing
    /// a separate variant.
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

/// Produce the render payload for a tool result given the tool name.
///
/// Dispatch is tool-name-aware so the log surfaces the richest
/// rendering the result supports. `TodoWrite` yields structured todos;
/// `Edit` / `Write` yield a unified diff when the result JSON carries
/// a diff string; everything else degrades to a short text preview
/// lifted from the first obvious field (stdout, content, first-array
/// entry) so the reader sees proof of execution without needing to
/// scroll.
pub fn payload_from_result(name: &str, result: &Value) -> Option<ToolPayload> {
    match name {
        "TodoWrite" => todos_payload(result),
        "Edit" | "Write" => diff_payload(result).or_else(|| preview_payload(result)),
        _ => preview_payload(result),
    }
}

/// Produce a render payload from a tool-dispatch error string.
/// Hoisted into a helper so state.rs has a single call site mirroring
/// [`payload_from_result`] for the `Err` arm.
pub fn payload_from_error(err: &str) -> ToolPayload {
    ToolPayload::Preview(one_line_preview(err, 240))
}

fn todos_payload(result: &Value) -> Option<ToolPayload> {
    // Upstream's TodoWrite returns the full todo list on the result;
    // tests use `{"todos": [...]}` or a bare array.
    let items = result
        .get("todos")
        .or(Some(result))
        .and_then(|v| v.as_array())?;
    let parsed: Vec<todos::TodoItem> = items
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect();
    if parsed.is_empty() {
        None
    } else {
        Some(ToolPayload::Todos(parsed))
    }
}

fn diff_payload(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    // Accept either `diff`, `unified_diff`, or a top-level string that
    // starts with a hunk header — Edit/Write shapes vary by dispatcher.
    if let Some(s) = obj.get("diff").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            return Some(ToolPayload::Diff(s.to_string()));
        }
    }
    if let Some(s) = obj.get("unified_diff").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            return Some(ToolPayload::Diff(s.to_string()));
        }
    }
    None
}

fn preview_payload(result: &Value) -> Option<ToolPayload> {
    // Mirror the textual shapes `mod.rs::summarize_tool_result` already
    // handles so render and legacy-summary agree on what counts as the
    // "headline" field.
    let text = match result {
        Value::String(s) => one_line_preview(s, 240),
        Value::Array(items) => format!("{} item{}", items.len(), if items.len() == 1 { "" } else { "s" }),
        Value::Object(obj) => {
            if let Some(n) = obj.get("numFiles").and_then(|v| v.as_u64()) {
                return Some(ToolPayload::Preview(format!(
                    "{n} file{}",
                    if n == 1 { "" } else { "s" }
                )));
            }
            if let Some(matches) = obj.get("matches").and_then(|v| v.as_array()) {
                return Some(ToolPayload::Preview(format!(
                    "{} match{}",
                    matches.len(),
                    if matches.len() == 1 { "" } else { "es" }
                )));
            }
            if let Some(files) = obj.get("files").and_then(|v| v.as_array()) {
                return Some(ToolPayload::Preview(format!(
                    "{} file{}",
                    files.len(),
                    if files.len() == 1 { "" } else { "s" }
                )));
            }
            if let Some(output) = obj.get("output").and_then(|v| v.as_str()) {
                let exit = obj.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(0);
                let prefix = if exit == 0 {
                    String::new()
                } else {
                    format!("exit {exit}: ")
                };
                return Some(ToolPayload::Preview(format!(
                    "{prefix}{}",
                    one_line_preview(output, 220)
                )));
            }
            if let Some(s) = obj.get("content").and_then(|v| v.as_str()) {
                return Some(ToolPayload::Preview(one_line_preview(s, 240)));
            }
            // Nothing recognizable — fall back to a compact field count.
            format!("{} field{}", obj.len(), if obj.len() == 1 { "" } else { "s" })
        }
        Value::Null => String::new(),
        _ => result.to_string(),
    };
    if text.is_empty() {
        None
    } else {
        Some(ToolPayload::Preview(text))
    }
}

fn one_line_preview(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    if flat.chars().count() > max {
        let mut t: String = flat.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    } else {
        flat
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

    #[test]
    fn payload_from_result_todo_write_returns_todos() {
        let value = serde_json::json!({
            "todos": [
                {"content": "first", "status": "pending"},
                {"content": "second", "status": "completed"},
            ]
        });
        let payload = payload_from_result("TodoWrite", &value).expect("todos payload");
        match payload {
            ToolPayload::Todos(items) => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].content, "first");
            }
            other => panic!("expected Todos, got {other:?}"),
        }
    }

    #[test]
    fn payload_from_result_read_returns_preview() {
        let value = serde_json::json!({ "content": "line one\nline two" });
        let payload = payload_from_result("Read", &value).expect("preview");
        match payload {
            ToolPayload::Preview(s) => {
                assert!(s.starts_with("line one"));
                assert!(!s.contains('\n'), "preview flattens newlines");
            }
            other => panic!("expected Preview, got {other:?}"),
        }
    }

    #[test]
    fn payload_from_result_glob_returns_file_count() {
        let value = serde_json::json!({
            "numFiles": 3,
            "filenames": ["a.rs", "b.rs", "c.rs"],
            "truncated": false,
        });
        let payload = payload_from_result("Glob", &value).expect("preview");
        match payload {
            ToolPayload::Preview(s) => assert!(s.contains("3 file")),
            other => panic!("expected Preview, got {other:?}"),
        }
    }

    #[test]
    fn payload_from_result_edit_returns_diff_when_present() {
        let value = serde_json::json!({
            "diff": "@@ -1 +1 @@\n-a\n+b",
        });
        let payload = payload_from_result("Edit", &value).expect("diff");
        assert!(matches!(payload, ToolPayload::Diff(_)));
    }

    #[test]
    fn payload_from_error_returns_preview_flattened() {
        let payload = payload_from_error("boom:\nsecond line");
        match payload {
            ToolPayload::Preview(s) => {
                assert!(s.starts_with("boom"));
                assert!(!s.contains('\n'));
            }
            other => panic!("expected Preview, got {other:?}"),
        }
    }
}
