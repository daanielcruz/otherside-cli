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
//!
//! Per-tool parity (2026-04-19): [`summarize_args`] and
//! [`payload_from_result`] carry tool-aware branches that mirror the
//! upstream 2.1.113 `tools/*/UI.tsx` renderers. See
//! `docs/design/tool-render-parity-2026-04-19.md` (outer repo) for the
//! header/preview convention table.

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
    pub args: &'a Value,
    pub status: ToolStatus,
    pub elapsed_ms: Option<u64>,
    pub payload: Option<&'a ToolPayload>,
}

/// Render a single tool call into owned Lines ready to splice into
/// the streaming log.
///
/// Upstream-shape header: `⏺ ToolName(arg=value)`. Status is conveyed
/// by the bullet color (MUTED+BLINK running → SUCCESS ok → ERROR err);
/// no explicit status text or elapsed chip on the header row. Payload
/// preview (when available) renders on the next line under a `⎿`
/// gutter in MUTED.
pub fn render_tool_call(view: &ToolCallView<'_>) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();

    // Header row: `⏺ ToolName(arg_summary)`.
    let arg_summary = summarize_args(view.name, view.args);
    let parens = if arg_summary.is_empty() {
        String::new()
    } else {
        format!("({arg_summary})")
    };
    let mut header_spans: Vec<Span<'static>> = Vec::with_capacity(3);
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
    if !parens.is_empty() {
        header_spans.push(Span::styled(
            parens,
            Style::default().fg(theme::MUTED),
        ));
    }
    let _ = view.elapsed_ms; // suppressed on the header per upstream format
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

/// Summarize the tool-call `args` JSON into the compact header parens
/// form. Tool-aware branches mirror upstream 2.1.113 `tools/*/UI.tsx`
/// `renderToolUseMessage` conventions (see docs/design/
/// tool-render-parity-2026-04-19.md):
///
/// - `Bash` → bare command value: `(ls -la /tmp)`
/// - `Skill` → bare skill name: `(verifier-tui)`
/// - `Agent` → bare description: `(Audit ship-readiness)`
/// - `ToolSearch` → empty (upstream returns `null` from its render)
/// - `Read` → `file_path=<path>` + optional `pages=` / `offset=` / `limit=`
/// - `Edit` / `Write` → `file_path=<path>`
/// - `Glob` / `Grep` → `pattern=<pat>` + optional `path=<p>`
/// - fallback → `key=value[, key2=value2]` (first 1-2 fields)
///
/// Clips long strings, flattens newlines. Empty / non-object → empty
/// string.
pub fn summarize_args(name: &str, args: &Value) -> String {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    if obj.is_empty() {
        return String::new();
    }

    // ToolSearch upstream returns `null` from renderToolUseMessage so
    // the header shows just `⏺ ToolSearch`. Mirror the hide.
    if name == "ToolSearch" {
        return String::new();
    }

    // Command-centric tools drop the key prefix — the single primary
    // field *is* the identity of the call (Bash's command, Skill's
    // skill name, Agent's description).
    if name == "Bash" {
        if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
            return clip_flat(cmd, 90);
        }
    }
    if name == "Skill" {
        if let Some(s) = obj.get("skill").and_then(|v| v.as_str()) {
            return clip_flat(s, 60);
        }
    }
    if name == "Agent" {
        if let Some(s) = obj.get("description").and_then(|v| v.as_str()) {
            return clip_flat(s, 80);
        }
    }

    // File-centric tools: show `file_path=<path>` first, then add
    // optional qualifiers upstream surfaces inline (pages, offset,
    // limit for Read).
    if name == "Read" {
        let mut parts: Vec<String> = Vec::with_capacity(3);
        if let Some(fp) = obj.get("file_path").and_then(|v| v.as_str()) {
            parts.push(format!("file_path={}", clip_flat(fp, 80)));
        }
        if let Some(pages) = obj.get("pages").and_then(|v| v.as_str()) {
            parts.push(format!("pages={}", clip_flat(pages, 20)));
        } else {
            if let Some(offset) = obj.get("offset").and_then(|v| v.as_u64()) {
                parts.push(format!("offset={offset}"));
            }
            if let Some(limit) = obj.get("limit").and_then(|v| v.as_u64()) {
                parts.push(format!("limit={limit}"));
            }
        }
        if !parts.is_empty() {
            return parts.join(", ");
        }
    }
    if name == "Edit" || name == "Write" {
        if let Some(fp) = obj.get("file_path").and_then(|v| v.as_str()) {
            return format!("file_path={}", clip_flat(fp, 80));
        }
    }

    // Search tools: `pattern=<pat>` with optional `path=<p>`.
    if name == "Glob" || name == "Grep" {
        let mut parts: Vec<String> = Vec::with_capacity(2);
        if let Some(pat) = obj.get("pattern").and_then(|v| v.as_str()) {
            parts.push(format!("pattern={}", clip_flat(pat, 60)));
        }
        if let Some(p) = obj.get("path").and_then(|v| v.as_str()) {
            parts.push(format!("path={}", clip_flat(p, 60)));
        }
        if !parts.is_empty() {
            return parts.join(", ");
        }
    }

    // Generic fallback — first 2 fields as key=value pairs.
    let mut parts: Vec<String> = Vec::with_capacity(2);
    for (k, v) in obj.iter().take(2) {
        let rendered = match v {
            Value::String(s) => clip_flat(s, 60),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            other => clip_flat(&other.to_string(), 40),
        };
        parts.push(format!("{k}={rendered}"));
    }
    parts.join(", ")
}

fn clip_flat(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    if flat.chars().count() > max {
        let mut t: String = flat.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    } else {
        flat
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
        "Edit" => diff_payload(result).or_else(|| edit_preview(result)),
        "Write" => diff_payload(result).or_else(|| write_preview(result)),
        "Read" => read_preview(result).or_else(|| preview_payload(result)),
        "Glob" => glob_preview(result).or_else(|| preview_payload(result)),
        "Grep" => grep_preview(result).or_else(|| preview_payload(result)),
        "Skill" => skill_preview(result).or_else(|| preview_payload(result)),
        "ToolSearch" => tool_search_preview(result).or_else(|| preview_payload(result)),
        "Agent" => agent_preview(result).or_else(|| preview_payload(result)),
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

/// Read result preview — upstream emits `Read N lines` / `Read N cells` /
/// `Read image (size)` / `Read PDF (size)` / `Unchanged since last read`.
/// Our dispatcher returns `{content, numLines, startLine, totalLines}`,
/// so we surface the line count plus a short body excerpt.
fn read_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let num = obj.get("numLines").and_then(|v| v.as_u64())?;
    let head = format!("Read {num} {}", if num == 1 { "line" } else { "lines" });
    // Pair the summary with a short body excerpt so the reader sees
    // what got read, not just the count.
    if let Some(content) = obj.get("content").and_then(|v| v.as_str()) {
        if !content.is_empty() {
            let body = trim_multiline(content, 5, 180);
            return Some(ToolPayload::Preview(format!("{head}\n{body}")));
        }
    }
    Some(ToolPayload::Preview(head))
}

/// Edit fallback (non-diff) preview. Our dispatcher returns
/// `{status, file_path, replaced}` when no diff is attached. Upstream
/// only ever shows a diff — when none is available we at least surface
/// the replacement count + target path.
fn edit_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let fp = obj.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
    let replaced = obj.get("replaced").and_then(|v| v.as_u64());
    let text = match replaced {
        Some(n) => format!(
            "{n} replacement{} in {fp}",
            if n == 1 { "" } else { "s" }
        ),
        None => format!("Updated {fp}"),
    };
    if text.trim().is_empty() {
        None
    } else {
        Some(ToolPayload::Preview(text))
    }
}

/// Write fallback preview. Upstream emits `Wrote N lines to <path>`;
/// our dispatcher returns `{status, file_path, created, bytes_written}`,
/// so we pivot to bytes and preserve the `created` vs `updated` split.
fn write_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let fp = obj.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = obj.get("bytes_written").and_then(|v| v.as_u64());
    let created = obj.get("created").and_then(|v| v.as_bool()).unwrap_or(false);
    let verb = if created { "Created" } else { "Wrote" };
    let text = match bytes {
        Some(n) if !fp.is_empty() => format!(
            "{verb} {n} byte{} to {fp}",
            if n == 1 { "" } else { "s" }
        ),
        Some(n) => format!("{verb} {n} bytes"),
        None if !fp.is_empty() => format!("{verb} {fp}"),
        None => return None,
    };
    Some(ToolPayload::Preview(text))
}

/// Glob preview — `Found N files` + up to 10 filenames under the gutter.
/// Mirrors upstream's `SearchResultSummary` when verbose lists filenames
/// (our render always shows a short list so the reader doesn't have to
/// re-run the search to see what matched).
fn glob_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let n = obj.get("numFiles").and_then(|v| v.as_u64())?;
    let head = format!("Found {n} {}", if n == 1 { "file" } else { "files" });
    if let Some(names) = obj.get("filenames").and_then(|v| v.as_array()) {
        if !names.is_empty() {
            let list: Vec<String> = names
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            let joined = list.join("\n");
            let body = trim_multiline(&joined, 10, 180);
            return Some(ToolPayload::Preview(format!("{head}\n{body}")));
        }
    }
    Some(ToolPayload::Preview(head))
}

/// Grep preview — mode-aware per upstream `GrepTool/UI.tsx`.
/// - `files_with_matches` (default): `Found N match(es)` + up to 10 paths.
/// - `content`: `Found N line(s)`.
/// - `count`: `Found N match(es) across M file(s)`.
/// Our dispatcher emits `{mode, matches, truncated, exit}` — `matches`
/// is a string list whose meaning depends on `mode`.
fn grep_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let matches = obj.get("matches").and_then(|v| v.as_array())?;
    let n = matches.len() as u64;
    let mode = obj
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("files_with_matches");
    let head = match mode {
        "content" => format!("Found {n} {}", if n == 1 { "line" } else { "lines" }),
        "count" => format!("Found {n} {}", if n == 1 { "match" } else { "matches" }),
        _ => format!("Found {n} {}", if n == 1 { "match" } else { "matches" }),
    };
    if matches.is_empty() {
        return Some(ToolPayload::Preview(head));
    }
    let list: Vec<String> = matches
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    if list.is_empty() {
        return Some(ToolPayload::Preview(head));
    }
    let joined = list.join("\n");
    let body = trim_multiline(&joined, 10, 200);
    Some(ToolPayload::Preview(format!("{head}\n{body}")))
}

/// Skill preview — upstream emits `Successfully loaded skill` + optional
/// tool count + model. Our dispatcher returns `{skill, args, content}`
/// where `content` is the skill's SKILL.md body. Surface the first few
/// lines so the reader sees what the skill actually does.
fn skill_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let skill = obj.get("skill").and_then(|v| v.as_str()).unwrap_or("");
    let content = obj.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let head = if skill.is_empty() {
        "Loaded skill".to_string()
    } else {
        format!("Loaded skill {skill}")
    };
    if content.is_empty() {
        return Some(ToolPayload::Preview(head));
    }
    let body = trim_multiline(content, 5, 200);
    Some(ToolPayload::Preview(format!("{head}\n{body}")))
}

/// ToolSearch preview — upstream renders tool_reference blocks. Our
/// dispatcher returns `{query, max_results, tools}` where `tools` is a
/// list of `{name, description, input_schema}`. Surface count + names.
fn tool_search_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let tools = obj.get("tools").and_then(|v| v.as_array())?;
    let n = tools.len() as u64;
    let head = format!("Found {n} {}", if n == 1 { "tool" } else { "tools" });
    if tools.is_empty() {
        return Some(ToolPayload::Preview(head));
    }
    let names: Vec<String> = tools
        .iter()
        .filter_map(|t| {
            t.get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();
    if names.is_empty() {
        return Some(ToolPayload::Preview(head));
    }
    // Upstream lists tool names inline; we cap at 10 so long result
    // lists stay one-line.
    let shown: Vec<String> = names.iter().take(10).cloned().collect();
    let tail = if names.len() > shown.len() {
        format!(", +{} more", names.len() - shown.len())
    } else {
        String::new()
    };
    Some(ToolPayload::Preview(format!(
        "{head}: {}{tail}",
        shown.join(", ")
    )))
}

/// Agent preview — upstream emits `Done (N tool uses · M tokens · T)`.
/// Our dispatcher stub returns `{status, subagent_type_requested,
/// description, prompt_preview, reason}` because subagent execution is
/// not wired yet. Surface the `reason` (when status != "completed") so
/// the user sees why nothing happened.
fn agent_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let status = obj
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    // Real completion (future wiring): render the upstream-shape summary.
    if status == "completed" {
        let tool_uses = obj
            .get("totalToolUseCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let tokens = obj.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let duration = obj
            .get("totalDurationMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let dur_s = duration / 1000;
        return Some(ToolPayload::Preview(format!(
            "Done ({} tool use{} · {} tokens · {}s)",
            tool_uses,
            if tool_uses == 1 { "" } else { "s" },
            tokens,
            dur_s
        )));
    }
    // Stubbed path — show the reason string so callers understand the
    // dispatcher didn't actually run the subagent.
    let reason = obj
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("agent dispatch returned no result");
    Some(ToolPayload::Preview(one_line_preview(reason, 240)))
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
                    format!("exit {exit}:\n")
                };
                // Keep multi-line — upstream Bash renders first N lines
                // of stdout under the gutter, one ⎿-prefixed line each.
                // Cap at 20 lines * 200 chars each so a chatty command
                // doesn't flood the log.
                let trimmed = trim_multiline(output, 20, 200);
                return Some(ToolPayload::Preview(format!("{prefix}{trimmed}")));
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

/// Preserve up to `max_lines` lines of `s`, clipping each to
/// `max_chars`. Appends a `… (N more lines)` tail when truncation
/// happens. Used by Bash-shape previews where multi-line structure
/// is the point.
fn trim_multiline(s: &str, max_lines: usize, max_chars: usize) -> String {
    let all_lines: Vec<&str> = s.lines().collect();
    let total = all_lines.len();
    let mut out: Vec<String> = Vec::with_capacity(max_lines);
    for line in all_lines.iter().take(max_lines) {
        let clipped: String = if line.chars().count() > max_chars {
            let mut t: String = line.chars().take(max_chars.saturating_sub(1)).collect();
            t.push('…');
            t
        } else {
            (*line).to_string()
        };
        out.push(clipped);
    }
    if total > max_lines {
        let remaining = total - max_lines;
        out.push(format!(
            "… ({} more line{})",
            remaining,
            if remaining == 1 { "" } else { "s" }
        ));
    }
    out.join("\n")
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
    fn header_matches_upstream_shape() {
        let args = serde_json::json!({"file_path": "/tmp/x.rs"});
        let view = ToolCallView {
            name: "Read",
            args: &args,
            status: ToolStatus::Ok,
            elapsed_ms: Some(1500),
            payload: None,
        };
        let lines = render_tool_call(&view);
        let text = collect_text(&lines);
        // Upstream shape: `⏺ Read(file_path=/tmp/x.rs)` — no status
        // text, no elapsed chip on the header row.
        assert!(text.contains("Read"));
        assert!(text.contains("file_path=/tmp/x.rs"));
        assert!(!text.contains(" ok "));
        assert!(!text.contains("1s"));
    }

    #[test]
    fn preview_payload_renders_under_gutter() {
        let args = serde_json::json!({});
        let preview = ToolPayload::Preview("first line\nsecond line".into());
        let view = ToolCallView {
            name: "Glob",
            args: &args,
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
        let args = serde_json::json!({});
        let payload = ToolPayload::Todos(items);
        let view = ToolCallView {
            name: "TodoWrite",
            args: &args,
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
        let args = serde_json::json!({});
        let payload = ToolPayload::Diff(frag.into());
        let view = ToolCallView {
            name: "Edit",
            args: &args,
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

    // ------------------------------------------------------------------
    // Per-tool parity tests (2026-04-19). See
    // docs/design/tool-render-parity-2026-04-19.md (outer).
    // ------------------------------------------------------------------

    fn expect_preview(p: ToolPayload) -> String {
        match p {
            ToolPayload::Preview(s) => s,
            other => panic!("expected Preview, got {other:?}"),
        }
    }

    #[test]
    fn summarize_args_read_renders_file_path_and_window() {
        let a = serde_json::json!({"file_path": "/tmp/x.rs", "offset": 10, "limit": 50});
        let out = summarize_args("Read", &a);
        assert!(out.contains("file_path=/tmp/x.rs"), "got: {out}");
        assert!(out.contains("offset=10"), "got: {out}");
        assert!(out.contains("limit=50"), "got: {out}");
    }

    #[test]
    fn summarize_args_read_pages_supersedes_window() {
        let a = serde_json::json!({"file_path": "/tmp/doc.pdf", "pages": "1-5", "offset": 10});
        let out = summarize_args("Read", &a);
        assert!(out.contains("pages=1-5"), "got: {out}");
        assert!(!out.contains("offset"), "pages should suppress offset: {out}");
    }

    #[test]
    fn summarize_args_skill_is_bare() {
        let a = serde_json::json!({"skill": "verifier-tui", "args": "flag=1"});
        let out = summarize_args("Skill", &a);
        assert_eq!(out, "verifier-tui");
    }

    #[test]
    fn summarize_args_agent_is_bare_description() {
        let a = serde_json::json!({"description": "Audit ship-readiness", "prompt": "long…"});
        let out = summarize_args("Agent", &a);
        assert_eq!(out, "Audit ship-readiness");
    }

    #[test]
    fn summarize_args_tool_search_is_hidden() {
        let a = serde_json::json!({"query": "slack", "max_results": 5});
        let out = summarize_args("ToolSearch", &a);
        assert_eq!(out, "");
    }

    #[test]
    fn summarize_args_glob_grep_emit_pattern_and_path() {
        let a = serde_json::json!({"pattern": "*.rs", "path": "/tmp"});
        assert!(summarize_args("Glob", &a).contains("pattern=*.rs"));
        assert!(summarize_args("Glob", &a).contains("path=/tmp"));
        assert!(summarize_args("Grep", &a).contains("pattern=*.rs"));
    }

    #[test]
    fn payload_from_result_read_lines_summary() {
        let v = serde_json::json!({
            "content": "     1\talpha\n     2\tbeta",
            "numLines": 2,
            "startLine": 1,
            "totalLines": 2,
        });
        let s = expect_preview(payload_from_result("Read", &v).unwrap());
        assert!(s.starts_with("Read 2 lines"), "got: {s}");
        assert!(s.contains("alpha"), "body excerpt present: {s}");
    }

    #[test]
    fn payload_from_result_read_singular() {
        let v = serde_json::json!({
            "content": "     1\tonly",
            "numLines": 1,
            "startLine": 1,
            "totalLines": 1,
        });
        let s = expect_preview(payload_from_result("Read", &v).unwrap());
        assert!(s.starts_with("Read 1 line"), "got: {s}");
    }

    #[test]
    fn payload_from_result_write_bytes_and_path() {
        let v = serde_json::json!({
            "status": "ok",
            "file_path": "/tmp/out.txt",
            "created": true,
            "bytes_written": 42,
        });
        let s = expect_preview(payload_from_result("Write", &v).unwrap());
        assert!(s.contains("Created"), "got: {s}");
        assert!(s.contains("42 bytes"), "got: {s}");
        assert!(s.contains("/tmp/out.txt"), "got: {s}");
    }

    #[test]
    fn payload_from_result_write_updated_singular() {
        let v = serde_json::json!({
            "status": "ok",
            "file_path": "/tmp/out.txt",
            "created": false,
            "bytes_written": 1,
        });
        let s = expect_preview(payload_from_result("Write", &v).unwrap());
        assert!(s.starts_with("Wrote 1 byte "), "singular: {s}");
    }

    #[test]
    fn payload_from_result_edit_without_diff_shows_replaced() {
        let v = serde_json::json!({
            "status": "ok",
            "file_path": "/tmp/x.rs",
            "replaced": 3,
        });
        let s = expect_preview(payload_from_result("Edit", &v).unwrap());
        assert!(s.contains("3 replacements"), "got: {s}");
        assert!(s.contains("/tmp/x.rs"), "got: {s}");
    }

    #[test]
    fn payload_from_result_glob_shows_count_and_file_list() {
        let v = serde_json::json!({
            "numFiles": 2,
            "filenames": ["/a.rs", "/b.rs"],
            "truncated": false,
            "durationMs": 12,
        });
        let s = expect_preview(payload_from_result("Glob", &v).unwrap());
        assert!(s.starts_with("Found 2 files"), "got: {s}");
        assert!(s.contains("/a.rs"), "list body: {s}");
        assert!(s.contains("/b.rs"), "list body: {s}");
    }

    #[test]
    fn payload_from_result_glob_singular_noun() {
        let v = serde_json::json!({
            "numFiles": 1,
            "filenames": ["/only.rs"],
            "truncated": false,
            "durationMs": 1,
        });
        let s = expect_preview(payload_from_result("Glob", &v).unwrap());
        assert!(s.starts_with("Found 1 file\n"), "got: {s}");
    }

    #[test]
    fn payload_from_result_grep_default_mode_files() {
        let v = serde_json::json!({
            "mode": "files_with_matches",
            "matches": ["/a.rs", "/b.rs", "/c.rs"],
            "truncated": false,
            "exit": 0,
        });
        let s = expect_preview(payload_from_result("Grep", &v).unwrap());
        assert!(s.starts_with("Found 3 matches"), "got: {s}");
        assert!(s.contains("/a.rs"), "paths listed: {s}");
    }

    #[test]
    fn payload_from_result_grep_content_mode_reports_lines() {
        let v = serde_json::json!({
            "mode": "content",
            "matches": ["/a.rs:1:hit", "/b.rs:7:hit2"],
            "truncated": false,
            "exit": 0,
        });
        let s = expect_preview(payload_from_result("Grep", &v).unwrap());
        assert!(s.starts_with("Found 2 lines"), "got: {s}");
    }

    #[test]
    fn payload_from_result_skill_shows_name_and_excerpt() {
        let v = serde_json::json!({
            "skill": "verifier-tui",
            "args": "",
            "content": "# Skill: verifier-tui\nDoes tmux capture checks.",
        });
        let s = expect_preview(payload_from_result("Skill", &v).unwrap());
        assert!(s.starts_with("Loaded skill verifier-tui"), "got: {s}");
        assert!(s.contains("tmux"), "content excerpt: {s}");
    }

    #[test]
    fn payload_from_result_tool_search_lists_names() {
        let v = serde_json::json!({
            "query": "read",
            "max_results": 5,
            "tools": [
                {"name": "Read", "description": "d", "input_schema": {}},
                {"name": "ReadFoo", "description": "d", "input_schema": {}},
            ]
        });
        let s = expect_preview(payload_from_result("ToolSearch", &v).unwrap());
        assert!(s.contains("Found 2 tools"), "got: {s}");
        assert!(s.contains("Read"), "got: {s}");
        assert!(s.contains("ReadFoo"), "got: {s}");
    }

    #[test]
    fn payload_from_result_tool_search_empty_reports_zero() {
        let v = serde_json::json!({"query": "zz", "max_results": 5, "tools": []});
        let s = expect_preview(payload_from_result("ToolSearch", &v).unwrap());
        assert!(s.contains("Found 0 tools"), "got: {s}");
    }

    #[test]
    fn payload_from_result_agent_stub_surfaces_reason() {
        let v = serde_json::json!({
            "status": "unavailable",
            "subagent_type_requested": "general-purpose",
            "description": "x",
            "prompt_preview": "p",
            "reason": "subagents registry not yet wired",
        });
        let s = expect_preview(payload_from_result("Agent", &v).unwrap());
        assert!(s.contains("subagents registry"), "got: {s}");
    }

    #[test]
    fn payload_from_result_agent_completed_shows_done_summary() {
        let v = serde_json::json!({
            "status": "completed",
            "totalToolUseCount": 5,
            "totalTokens": 12345,
            "totalDurationMs": 135000,
        });
        let s = expect_preview(payload_from_result("Agent", &v).unwrap());
        assert!(s.starts_with("Done ("), "got: {s}");
        assert!(s.contains("5 tool uses"), "got: {s}");
        assert!(s.contains("12345 tokens"), "got: {s}");
        assert!(s.contains("135s"), "got: {s}");
    }
}
