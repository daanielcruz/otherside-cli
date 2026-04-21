//! Tool-call render path — `⏺ <ToolName>  ⎿ <status|preview>`.
//!
//! 015 wires this module into the streaming log. `run_agent_turns`
//! emits typed `StreamEvent::ToolCallStart` / `ToolCallFinish` events;
//! `ConversationState` routes them into `active_tool_calls`; the log
//! painter iterates that vector each frame and calls
//! [`render_tool_call`] for every in-flight / finalized entry.
//!
//! The `Running` bullet animates by toggling the glyph on/off every
//! [`BLINK_INTERVAL_TICKS`] frames (600ms @ 20fps ticker), mirroring
//! upstream's `useBlink(600ms)` hook. Terminal `SLOW_BLINK` was
//! unreliable (xterm/iTerm strip `ESC[5m`); glyph alternation is
//! portable. `Ok` transitions to solid `theme::SUCCESS`, `Error` to
//! solid `theme::ERROR`.
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

/// Space glyph used in place of the bullet on the "off" half of the
/// blink cycle while Running. Matches upstream `ToolUseLoader` which
/// substitutes `' '` for `BLACK_CIRCLE` when `isBlinking` is false.
const BULLET_HIDDEN: &str = " ";

/// How many spinner ticks make up one half of the blink cycle.
/// Spinner ticker runs at 50ms, so 12 ticks = 600ms — the same
/// interval upstream uses (`useBlink.ts::BLINK_INTERVAL_MS`).
const BLINK_INTERVAL_TICKS: u64 = 12;

/// Tool call status. Drives the badge color on the bullet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

    /// Extra text modifiers layered on top of the color. All three
    /// states render BOLD. Blinking during `Running` is handled by
    /// tick-driven glyph alternation in [`render_tool_call`] rather
    /// than the terminal-native `SLOW_BLINK` (stripped by most
    /// modern terminals).
    pub(crate) fn modifier(self) -> ratatui::style::Modifier {
        use ratatui::style::Modifier;
        let _ = self;
        Modifier::BOLD
    }
}

/// Opaque payload attached to a tool call so the render path can pick
/// a specialized sub-renderer (todos, diff, plain text) without
/// parsing the JSON twice.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    /// Bash result — stdout rendered dim, stderr rendered in
    /// `theme::ERROR` so error output reads as distinct from normal
    /// program output. Matches upstream `BashToolResultMessage`.
    Bash {
        stdout: String,
        stderr: String,
        exit_code: i64,
    },
}

/// Serializable archive shape for a finished tool call. Used by
/// [`super::state::format_tool_history_entry`] to serialize a
/// [`super::state::ToolCallEntry`] into the `Role::Tool` message body
/// so the archived render path can reconstruct the full header +
/// payload via [`render_tool_call`], matching the live render.
///
/// `id` and `raw_result` are persisted so
/// [`super::state::ConversationState::history_for_request`] can
/// reconstruct the assistant `tool_use` / user `tool_result` pair
/// the wire layer ships on the next turn — the LLM needs to see its
/// own tool_use ids in history to reconcile against next-turn
/// `<task-notification>` blocks. Both are `serde(default)` so older
/// archives lacking the fields keep deserializing.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolCallArchive {
    pub status: ToolStatus,
    pub name: String,
    pub elapsed_ms: u64,
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<ToolPayload>,
    /// LLM-emitted `tool_use_id`. Used as the Anthropic
    /// `tool_use.id` and the matched `tool_result.tool_use_id` on the
    /// next-turn wire body. Empty string for archives written before
    /// this field landed (degraded but non-fatal — the history will
    /// emit unpaired ids in that case).
    #[serde(default)]
    pub id: String,
    /// Raw dispatcher result. Reshipped as the `tool_result.content`
    /// on the next-turn wire body so the model sees what the tool
    /// returned. `None` for archives written before this field
    /// landed and for error paths (the error text already lives in
    /// `payload`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_result: Option<Value>,
}

impl ToolCallArchive {
    /// Rebuild a [`ToolCallView`] pointing into `self`. Lifetime is
    /// tied to the archive so the caller keeps the archive alive while
    /// rendering.
    pub fn view(&self) -> ToolCallView<'_> {
        ToolCallView {
            name: &self.name,
            args: &self.args,
            status: self.status,
            elapsed_ms: Some(self.elapsed_ms),
            payload: self.payload.as_ref(),
            // Archived tool calls render with the compact
            // (non-verbose) layout — we don't preserve per-entry
            // verbose state across transcript serialization.
            verbose: false,
            // Archived entries render solid (no blink); the call is
            // already resolved.
            spinner_tick: 0,
        }
    }
}

/// Compact view the caller hands this module.
pub struct ToolCallView<'a> {
    pub name: &'a str,
    pub args: &'a Value,
    pub status: ToolStatus,
    pub elapsed_ms: Option<u64>,
    pub payload: Option<&'a ToolPayload>,
    /// Mirror the `verbose` render flag from upstream's `UI.tsx`
    /// entry points. When `true`, per-tool branches expand headers
    /// and previews (Glob/Grep file listings inline, Read `lines a-b`
    /// qualifier, WebFetch appended body, Bash full output). Default
    /// `false` keeps the compact render.
    pub verbose: bool,
    /// Global animation clock — the 20fps spinner ticker threaded in
    /// from `render::render`. Only consumed on `Running` status, where
    /// even-indexed blink halves show the bullet glyph and odd halves
    /// show a space. For finalized calls the value is irrelevant
    /// (bullet renders solid).
    pub spinner_tick: u64,
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
    // For the `Agent` tool we display the resolved subagent type
    // (e.g. `Explore(...)`) instead of the wrapper tool name —
    // mirrors upstream which paints `Explore(...)` even though the
    // wire `tool_use.name` is `Agent` (R-20 anchor preserved on the
    // wire side).
    let displayed_name: String = if view.name == "Agent" {
        view.args
            .as_object()
            .and_then(|o| o.get("subagent_type"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| view.name.to_string())
    } else {
        view.name.to_string()
    };
    let arg_summary = summarize_args(view.name, view.args, view.verbose);
    let parens = if arg_summary.is_empty() {
        String::new()
    } else {
        format!("({arg_summary})")
    };
    // Running status alternates glyph to simulate blink — even
    // 600ms windows show the bullet, odd windows show a space.
    // Finalized calls (Ok/Error) render the bullet solid.
    let bullet_glyph = if matches!(view.status, ToolStatus::Running)
        && (view.spinner_tick / BLINK_INTERVAL_TICKS) % 2 == 1
    {
        BULLET_HIDDEN
    } else {
        BULLET
    };
    let mut header_spans: Vec<Span<'static>> = Vec::with_capacity(3);
    header_spans.push(Span::styled(
        format!("{bullet_glyph} "),
        Style::default()
            .fg(view.status.color())
            .add_modifier(view.status.modifier()),
    ));
    header_spans.push(Span::styled(
        displayed_name,
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

    // Payload — indented under the gutter glyph. Upstream parity:
    // only the FIRST line carries `  ⎿ `; continuation lines align
    // under the label with a 4-space pad. Previously each wrapped
    // line emitted its own `⎿`, producing a column of symbols
    // rather than a tree-drawn preview.
    const GUTTER_HEAD: &str = "  ⎿ ";
    const GUTTER_CONT: &str = "    ";
    if let Some(payload) = view.payload {
        match payload {
            ToolPayload::Preview(text) => {
                for (i, raw) in text.lines().enumerate() {
                    let prefix = if i == 0 { GUTTER_HEAD } else { GUTTER_CONT };
                    out.push(Line::from(vec![
                        Span::styled(prefix.to_string(), Style::default().fg(theme::MUTED)),
                        Span::styled(raw.to_string(), Style::default().fg(theme::MUTED)),
                    ]));
                }
            }
            ToolPayload::Todos(items) => {
                let rendered = todos::render_lines(items);
                for (i, l) in rendered.into_iter().enumerate() {
                    let prefix = if i == 0 { GUTTER_HEAD } else { GUTTER_CONT };
                    let mut spans: Vec<Span<'static>> = Vec::with_capacity(l.spans.len() + 1);
                    spans.push(Span::styled(prefix.to_string(), Style::default().fg(theme::MUTED)));
                    spans.extend(l.spans);
                    out.push(Line::from(spans));
                }
            }
            ToolPayload::Diff(fragment) => {
                let rendered = diff::render_unified(fragment);
                for (i, l) in rendered.into_iter().enumerate() {
                    let prefix = if i == 0 { GUTTER_HEAD } else { GUTTER_CONT };
                    let mut spans: Vec<Span<'static>> = Vec::with_capacity(l.spans.len() + 1);
                    spans.push(Span::styled(prefix.to_string(), Style::default().fg(theme::MUTED)));
                    spans.extend(l.spans);
                    out.push(Line::from(spans));
                }
            }
            ToolPayload::Bash {
                stdout,
                stderr,
                exit_code,
            } => {
                let _ = exit_code;
                let mut emitted = 0usize;
                for raw in stdout.lines() {
                    let prefix = if emitted == 0 { GUTTER_HEAD } else { GUTTER_CONT };
                    out.push(Line::from(vec![
                        Span::styled(prefix.to_string(), Style::default().fg(theme::MUTED)),
                        Span::styled(raw.to_string(), Style::default().fg(theme::MUTED)),
                    ]));
                    emitted += 1;
                }
                for raw in stderr.lines() {
                    let prefix = if emitted == 0 { GUTTER_HEAD } else { GUTTER_CONT };
                    out.push(Line::from(vec![
                        Span::styled(prefix.to_string(), Style::default().fg(theme::MUTED)),
                        Span::styled(raw.to_string(), Style::default().fg(theme::ERROR)),
                    ]));
                    emitted += 1;
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
pub fn summarize_args(name: &str, args: &Value, verbose: bool) -> String {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    if obj.is_empty() {
        return String::new();
    }
    // `verbose` currently feeds a handful of per-tool branches
    // (WebSearch domain annotations, Read line range, Grep/Glob
    // expansion). Suppressing the unused-var lint until every branch
    // consumes it — documented as future-growth surface.
    let _ = verbose;

    // Tools whose upstream `renderToolUseMessage` returns `null` —
    // the header shows just `⏺ <Name>`, no args. Mirror the hide so
    // TaskCreate/List/Get/Update + ToolSearch don't leak args into
    // the transcript. See each tool's `UI.tsx`.
    if matches!(
        name,
        "ToolSearch" | "TaskCreate" | "TaskList" | "TaskGet" | "TaskUpdate"
    ) {
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

    // Read upstream header: bare displayPath, optionally followed by
    // ` · pages <X>` or ` · from line <N>` / ` · lines <a>-<b>`.
    // See `tools/FileReadTool/UI.tsx`.
    if name == "Read" {
        if let Some(fp) = obj.get("file_path").and_then(|v| v.as_str()) {
            let mut header = clip_flat(fp, 80);
            if let Some(pages) = obj.get("pages").and_then(|v| v.as_str()) {
                header.push_str(&format!(" · pages {}", clip_flat(pages, 20)));
            } else {
                let offset = obj.get("offset").and_then(|v| v.as_u64());
                let limit = obj.get("limit").and_then(|v| v.as_u64());
                match (offset, limit) {
                    (Some(o), Some(l)) => {
                        let end = o + l.saturating_sub(1);
                        header.push_str(&format!(" · lines {o}-{end}"));
                    }
                    (Some(o), None) => header.push_str(&format!(" · from line {o}")),
                    (None, Some(l)) => header.push_str(&format!(" · lines 1-{l}")),
                    (None, None) => {}
                }
            }
            return header;
        }
    }
    // Edit / Write upstream headers emit the bare `getDisplayPath` —
    // no `file_path=` prefix. See `tools/FileEditTool/UI.tsx` and
    // `tools/FileWriteTool/UI.tsx`.
    if name == "Edit" || name == "Write" {
        if let Some(fp) = obj.get("file_path").and_then(|v| v.as_str()) {
            return clip_flat(fp, 80);
        }
    }

    // Glob / Grep upstream headers quote both values:
    //   `pattern: "<pat>", path: "<path>"`
    // Matches `tools/GlobTool/UI.tsx` + `tools/GrepTool/UI.tsx`.
    if name == "Glob" || name == "Grep" {
        let mut parts: Vec<String> = Vec::with_capacity(2);
        if let Some(pat) = obj.get("pattern").and_then(|v| v.as_str()) {
            parts.push(format!("pattern: \"{}\"", clip_flat(pat, 60)));
        }
        if let Some(p) = obj.get("path").and_then(|v| v.as_str()) {
            parts.push(format!("path: \"{}\"", clip_flat(p, 60)));
        }
        if !parts.is_empty() {
            return parts.join(", ");
        }
    }

    // WebFetch upstream header = bare `url` (non-verbose). Mirror
    // that — no `url=` prefix, no prompt echo.
    // See `tools/WebFetchTool/UI.tsx::renderToolUseMessage:27`.
    if name == "WebFetch" {
        if let Some(u) = obj.get("url").and_then(|v| v.as_str()) {
            return clip_flat(u, 100);
        }
    }

    // WebSearch upstream header = `"query"` (quoted).
    // See `tools/WebSearchTool/UI.tsx::renderToolUseMessage:43`.
    if name == "WebSearch" {
        if let Some(q) = obj.get("query").and_then(|v| v.as_str()) {
            return format!("\"{}\"", clip_flat(q, 100));
        }
    }

    // NotebookEdit upstream header = `<displayPath>@<cell_id>` (no
    // prefix, no quotes). See `tools/NotebookEditTool/UI.tsx`.
    if name == "NotebookEdit" {
        let path = obj
            .get("notebook_path")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let cell = obj.get("cell_id").and_then(|v| v.as_str()).unwrap_or("");
        match (path.is_empty(), cell.is_empty()) {
            (false, false) => return format!("{}@{}", clip_flat(path, 70), clip_flat(cell, 40)),
            (false, true) => return clip_flat(path, 80),
            (true, false) => return format!("@{}", clip_flat(cell, 40)),
            _ => {}
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
pub fn payload_from_result(name: &str, result: &Value, verbose: bool) -> Option<ToolPayload> {
    match name {
        "TodoWrite" => todos_payload(result),
        "Edit" => diff_payload(result).or_else(|| edit_preview(result)),
        "Write" => diff_payload(result).or_else(|| write_preview(result)),
        "Read" => read_preview(result).or_else(|| preview_payload(result)),
        "Bash" => bash_preview(result).or_else(|| preview_payload(result)),
        "Glob" => glob_preview(result, verbose).or_else(|| preview_payload(result)),
        "Grep" => grep_preview(result, verbose).or_else(|| preview_payload(result)),
        "Skill" => skill_preview(result).or_else(|| preview_payload(result)),
        "ToolSearch" => tool_search_preview(result).or_else(|| preview_payload(result)),
        "Agent" => agent_preview(result).or_else(|| preview_payload(result)),
        "WebFetch" => web_fetch_preview(result).or_else(|| preview_payload(result)),
        "WebSearch" => web_search_preview(result).or_else(|| preview_payload(result)),
        "NotebookEdit" => notebook_edit_preview(result).or_else(|| preview_payload(result)),
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
    // Type-aware dispatch — upstream's `FileReadTool` UI picks one of
    // `Read <N> lines|cells|pages`, `Read image (<size>)`,
    // `Read PDF (<size>)`, or `Unchanged since last read` based on
    // the result discriminant. See `tools/FileReadTool/UI.tsx`.
    if obj
        .get("unchanged")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Some(ToolPayload::Preview(
            "Unchanged since last read".to_string(),
        ));
    }
    let kind = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let size_bytes = obj.get("bytes").and_then(|v| v.as_u64());
    let size_label = size_bytes.map(format_byte_size);
    match kind {
        "image" => {
            let suffix = size_label.map(|s| format!(" ({s})")).unwrap_or_default();
            return Some(ToolPayload::Preview(format!("Read image{suffix}")));
        }
        "pdf" => {
            let suffix = size_label.map(|s| format!(" ({s})")).unwrap_or_default();
            return Some(ToolPayload::Preview(format!("Read PDF{suffix}")));
        }
        "notebook" => {
            if let Some(n) = obj.get("numCells").and_then(|v| v.as_u64()) {
                return Some(ToolPayload::Preview(format!(
                    "Read {n} {}",
                    if n == 1 { "cell" } else { "cells" }
                )));
            }
        }
        "pdfPages" => {
            if let Some(n) = obj.get("numPages").and_then(|v| v.as_u64()) {
                let suffix = size_label
                    .map(|s| format!(" ({s})"))
                    .unwrap_or_default();
                return Some(ToolPayload::Preview(format!(
                    "Read {n} {}{suffix}",
                    if n == 1 { "page" } else { "pages" }
                )));
            }
        }
        _ => {}
    }

    let num = obj.get("numLines").and_then(|v| v.as_u64())?;
    let head = format!("Read {num} {}", if num == 1 { "line" } else { "lines" });
    if let Some(content) = obj.get("content").and_then(|v| v.as_str()) {
        if !content.is_empty() {
            let body = trim_multiline(content, 5, 180);
            return Some(ToolPayload::Preview(format!("{head}\n{body}")));
        }
    }
    Some(ToolPayload::Preview(head))
}

/// Format a byte count — same shape as `web_fetch_preview::format_file_size`
/// so the UI reads consistently.
fn format_byte_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes < KB {
        format!("{bytes} B")
    } else if bytes < MB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else if bytes < GB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    }
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
    // Upstream counts LINES written, not bytes. See
    // `tools/FileWriteTool/UI.tsx::FileWriteToolCreatedMessage`.
    // Prefer an explicit `numLines` field when the dispatcher
    // provides it; otherwise derive from `content`. Fall back to
    // `bytes_written` only as a last resort so the preview still
    // renders something meaningful for legacy payloads.
    let lines = obj
        .get("numLines")
        .or_else(|| obj.get("lines"))
        .and_then(|v| v.as_u64())
        .or_else(|| {
            obj.get("content")
                .and_then(|v| v.as_str())
                .map(|s| s.lines().count() as u64)
        });
    let bytes = obj.get("bytes_written").and_then(|v| v.as_u64());
    let created = obj.get("created").and_then(|v| v.as_bool()).unwrap_or(false);
    let verb = if created { "Created" } else { "Wrote" };
    let text = match (lines, bytes, fp.is_empty()) {
        (Some(n), _, false) => format!(
            "{verb} {n} line{} to {fp}",
            if n == 1 { "" } else { "s" }
        ),
        (Some(n), _, true) => format!(
            "{verb} {n} line{}",
            if n == 1 { "" } else { "s" }
        ),
        (None, Some(n), false) => format!(
            "{verb} {n} byte{} to {fp}",
            if n == 1 { "" } else { "s" }
        ),
        (None, Some(n), true) => format!("{verb} {n} bytes"),
        (None, None, false) => format!("{verb} {fp}"),
        (None, None, true) => return None,
    };
    Some(ToolPayload::Preview(text))
}

/// Bash preview — split stdout/stderr so the render path can paint
/// stderr in `theme::ERROR` while keeping stdout dim. Matches upstream
/// `BashToolResultMessage` which renders `<OutputLine content=stdout>`
/// followed by `<OutputLine content=stderr isError>`.
///
/// Accepts either the new separated shape (`stdout` + `stderr`) or the
/// legacy single-`output` shape (for captured transcripts written
/// before the split). When neither field is present returns None so
/// the generic fallback takes over.
fn bash_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let stdout = obj.get("stdout").and_then(|v| v.as_str()).map(str::to_string);
    let stderr = obj.get("stderr").and_then(|v| v.as_str()).map(str::to_string);
    let legacy = obj.get("output").and_then(|v| v.as_str()).map(str::to_string);
    if stdout.is_none() && stderr.is_none() && legacy.is_none() {
        return None;
    }
    let exit = obj.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(0);
    // Legacy single-stream captures route through stderr when exit != 0
    // so the render still reads the failure in red; otherwise they
    // land in stdout.
    let (stdout, stderr) = match (stdout, stderr, legacy) {
        (so, se, _) if so.is_some() || se.is_some() => {
            (so.unwrap_or_default(), se.unwrap_or_default())
        }
        (_, _, Some(legacy)) if exit != 0 => (String::new(), legacy),
        (_, _, Some(legacy)) => (legacy, String::new()),
        _ => unreachable!(),
    };
    let stdout = trim_multiline(&stdout, 20, 200);
    let stderr = trim_multiline(&stderr, 20, 200);
    if stdout.is_empty() && stderr.is_empty() && exit == 0 {
        // Upstream shows `(No output)` in dim text when both streams
        // are empty and the process succeeded. Surface the same note
        // under the gutter so the reader doesn't think the call hung.
        return Some(ToolPayload::Bash {
            stdout: String::from("(No output)"),
            stderr: String::new(),
            exit_code: exit,
        });
    }
    Some(ToolPayload::Bash {
        stdout,
        stderr,
        exit_code: exit,
    })
}

/// Glob preview — `Found N files`, with the filename list only in
/// verbose mode. Mirrors upstream `GlobTool/UI.tsx` which hides the
/// `SearchResultSummary` body unless the user ran with `--verbose`.
fn glob_preview(result: &Value, verbose: bool) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let n = obj.get("numFiles").and_then(|v| v.as_u64())?;
    let head = format!("Found {n} {}", if n == 1 { "file" } else { "files" });
    if !verbose {
        return Some(ToolPayload::Preview(head));
    }
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
fn grep_preview(result: &Value, verbose: bool) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let matches = obj.get("matches").and_then(|v| v.as_array())?;
    let n = matches.len() as u64;
    let mode = obj
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("files_with_matches");
    let head = match mode {
        "content" => format!("Found {n} {}", if n == 1 { "line" } else { "lines" }),
        "count" => {
            // Count mode: matches[] entries are `path:count` strings. Sum
            // totals and count distinct files to emit upstream's
            // `Found <total> match(es) across <files> file(s)` shape.
            let (total, file_count) = matches
                .iter()
                .filter_map(|v| v.as_str())
                .fold((0u64, 0u64), |(tot, files), s| {
                    let c = s
                        .rsplit_once(':')
                        .and_then(|(_, cnt)| cnt.trim().parse::<u64>().ok())
                        .unwrap_or(0);
                    (tot + c, files + 1)
                });
            format!(
                "Found {total} {} across {file_count} {}",
                if total == 1 { "match" } else { "matches" },
                if file_count == 1 { "file" } else { "files" },
            )
        }
        _ => format!("Found {n} {}", if n == 1 { "match" } else { "matches" }),
    };
    if matches.is_empty() || !verbose {
        // Non-verbose: only the head count, matching upstream's
        // `GrepTool/UI.tsx` default render. Body list re-emerges
        // when `verbose` is set (`/verbose` slash or settings.json).
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
/// Skill preview — upstream's `Byline` emits middot-joined segments:
/// `Successfully loaded skill · <N> tools allowed · <model>`.
/// Matches `tools/SkillTool/UI.tsx`. We stop surfacing the SKILL.md
/// body excerpt — upstream never shows it, and it noisily duplicates
/// content the skill itself will produce on its own.
fn skill_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    if obj.get("forked").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Some(ToolPayload::Preview("Done".to_string()));
    }
    let mut parts: Vec<String> = Vec::with_capacity(3);
    parts.push("Successfully loaded skill".to_string());
    if let Some(tools) = obj.get("tools").and_then(|v| v.as_array()) {
        let n = tools.len();
        parts.push(format!(
            "{n} {} allowed",
            if n == 1 { "tool" } else { "tools" }
        ));
    } else if let Some(n) = obj.get("tool_count").and_then(|v| v.as_u64()) {
        parts.push(format!(
            "{n} {} allowed",
            if n == 1 { "tool" } else { "tools" }
        ));
    }
    if let Some(model) = obj.get("model").and_then(|v| v.as_str()) {
        if !model.is_empty() {
            parts.push(model.to_string());
        }
    }
    Some(ToolPayload::Preview(parts.join(" · ")))
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
/// Preview line for WebFetch — matches upstream's
/// `Received <formatted_size> (<code> <codeText>)` shape.
/// See `tools/WebFetchTool/UI.tsx::renderToolResultMessage:57-61`.
fn web_fetch_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let bytes = obj.get("bytes").and_then(|v| v.as_u64());
    let code = obj.get("code").and_then(|v| v.as_u64());
    let code_text = obj.get("codeText").and_then(|v| v.as_str()).unwrap_or("");

    let size = bytes.map(format_file_size);
    let status_tail = match (code, code_text.is_empty()) {
        (Some(c), false) => Some(format!("({c} {code_text})")),
        (Some(c), true) => Some(format!("({c})")),
        (None, _) => None,
    };

    match (size, status_tail) {
        (Some(s), Some(tail)) => Some(ToolPayload::Preview(format!("Received {s} {tail}"))),
        (Some(s), None) => Some(ToolPayload::Preview(format!("Received {s}"))),
        (None, Some(tail)) => Some(ToolPayload::Preview(format!("Received {tail}"))),
        (None, None) => None,
    }
}

/// Format a byte count the way upstream does — `formatFileSize`
/// produces `"24 KB"` / `"1.2 MB"` rounded to single digits, matches
/// `utils/format.ts`.
fn format_file_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes < KB {
        format!("{bytes} B")
    } else if bytes < MB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else if bytes < GB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    }
}

/// Preview line for WebSearch — matches upstream's
/// `Did N search(es) in <timeDisplay>` shape.
/// See `tools/WebSearchTool/UI.tsx::renderToolResultMessage:79-92`.
/// Unavailable-backend stub is surfaced verbatim so the user sees
/// the configuration hint instead of an empty "Did 0 searches" line.
fn web_search_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let results = obj.get("results").and_then(|v| v.as_array())?;

    // Unavailable backend path — single string entry that starts
    // with `web_search_unavailable`. Surface it directly so the
    // preview reads as `⎿ web_search_unavailable - configure …`
    // instead of `Did 0 searches`.
    if results.len() == 1 {
        if let Some(s) = results[0].as_str() {
            if s.starts_with("web_search_unavailable") {
                return Some(ToolPayload::Preview(one_line_preview(s, 240)));
            }
        }
    }

    // Upstream `getSearchSummary`: only non-string entries count as a
    // "search". String entries are the unavailable markers + error
    // messages the model sees mid-transcript.
    let search_count = results
        .iter()
        .filter(|v| !v.is_string() && !v.is_null())
        .count();
    let duration_seconds = obj
        .get("durationSeconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let time_display = if duration_seconds >= 1.0 {
        format!("{}s", duration_seconds.round() as i64)
    } else {
        format!("{}ms", (duration_seconds * 1000.0).round() as i64)
    };
    let plural = if search_count == 1 { "" } else { "es" };
    Some(ToolPayload::Preview(format!(
        "Did {search_count} search{plural} in {time_display}"
    )))
}

/// Preview for NotebookEdit — matches upstream's
/// `Updated cell <cell_id>:` header followed by a peek at the new
/// source. See `tools/NotebookEditTool/UI.tsx`. Falls through to the
/// generic `preview_payload` when the dispatcher returned an error.
fn notebook_edit_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    if let Some(err) = obj.get("error").and_then(|v| v.as_str()) {
        return Some(ToolPayload::Preview(one_line_preview(err, 240)));
    }
    let cell = obj.get("cell_id").and_then(|v| v.as_str()).unwrap_or("");
    let new_source = obj
        .get("new_source")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if cell.is_empty() && new_source.is_empty() {
        return None;
    }
    let header = if cell.is_empty() {
        "Updated cell".to_string()
    } else {
        format!("Updated cell {cell}")
    };
    if new_source.is_empty() {
        return Some(ToolPayload::Preview(header));
    }
    let body = trim_multiline(new_source, 5, 180);
    Some(ToolPayload::Preview(format!("{header}\n{body}")))
}

fn agent_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let status = obj
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    // Completion path — upstream-shape summary:
    //   `Done (<N> tool uses · <formatNumber(tokens)> tokens · <formatDuration(ms)>)`
    // with thousands separators on tokens and `Xm Ys` / `Xs` on
    // duration per `tools/AgentTool/UI.tsx`.
    if status == "completed" {
        let tool_uses = obj
            .get("totalToolUseCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let tokens = obj.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let duration_ms = obj
            .get("totalDurationMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        return Some(ToolPayload::Preview(format!(
            "Done ({} tool use{} · {} tokens · {})",
            tool_uses,
            if tool_uses == 1 { "" } else { "s" },
            format_number_thousands(tokens),
            format_duration_ms(duration_ms),
        )));
    }
    // Background-route synthetic result — byte-match upstream
    // `tools/AgentTool/UI.tsx:345-358`:
    // `Backgrounded agent (↓ to manage · ctrl+o to expand)`.
    // The `↓ to manage` hint references the background tasks
    // dialog; `ctrl+o to expand` reveals the full agent prompt
    // in transcript mode (not wired yet, but the hint is anchor
    // text the user has been trained to recognize upstream).
    if status == "backgrounded" {
        return Some(ToolPayload::Preview(
            "Backgrounded agent (↓ to manage · ctrl+o to expand)".to_string(),
        ));
    }
    // Stubbed path — show the reason string so callers understand the
    // dispatcher didn't actually run the subagent.
    let reason = obj
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("agent dispatch returned no result");
    Some(ToolPayload::Preview(one_line_preview(reason, 240)))
}

/// Render an integer with comma thousands separators — matches
/// upstream's `formatNumber` at `utils/format.ts`. Not locale-aware
/// on purpose: upstream hard-codes `,` too.
fn format_number_thousands(n: u64) -> String {
    let raw = n.to_string();
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len() + raw.len() / 3);
    let mut count = 0;
    for b in bytes.iter().rev() {
        if count > 0 && count % 3 == 0 {
            out.push(',');
        }
        out.push(*b as char);
        count += 1;
    }
    out.chars().rev().collect()
}

/// Render an elapsed millisecond count as `Xs` (<60s) or `Xm Ys`
/// (>=60s). Matches upstream's `formatDuration` shape used by Agent
/// + other tool previews — seconds only, no fractional component.
fn format_duration_ms(ms: u64) -> String {
    let total_s = ms / 1000;
    if total_s < 60 {
        format!("{total_s}s")
    } else {
        let m = total_s / 60;
        let s = total_s % 60;
        if s == 0 {
            format!("{m}m")
        } else {
            format!("{m}m {s}s")
        }
    }
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
                    verbose: false,
                    spinner_tick: 0,
        };
        let lines = render_tool_call(&view);
        let text = collect_text(&lines);
        // Upstream shape: `⏺ Read(/tmp/x.rs)` — bare displayPath, no
        // key=value prefix, no status text, no elapsed chip.
        assert!(text.contains("Read"));
        assert!(text.contains("/tmp/x.rs"));
        assert!(!text.contains("file_path="));
        assert!(!text.contains(" ok "));
        assert!(!text.contains("1s"));
    }

    #[test]
    fn running_bullet_alternates_with_spinner_tick() {
        // 50ms ticker × BLINK_INTERVAL_TICKS(12) = 600ms per half —
        // mirrors upstream `useBlink`. Ticks 0..=11 show the bullet,
        // 12..=23 show the blank, 24..=35 show the bullet again.
        let args = serde_json::json!({});
        let mk_view = |tick: u64| ToolCallView {
            name: "Bash",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: tick,
        };
        let on_text = collect_text(&render_tool_call(&mk_view(0)));
        let off_text = collect_text(&render_tool_call(&mk_view(BLINK_INTERVAL_TICKS)));
        let on_again_text = collect_text(&render_tool_call(&mk_view(BLINK_INTERVAL_TICKS * 2)));
        assert!(on_text.starts_with(BULLET), "tick 0 should show bullet");
        assert!(
            !off_text.starts_with(BULLET),
            "tick {} should hide bullet (got {off_text:?})",
            BLINK_INTERVAL_TICKS
        );
        assert!(
            off_text.starts_with(BULLET_HIDDEN),
            "tick {} should show blank bullet (got {off_text:?})",
            BLINK_INTERVAL_TICKS
        );
        assert!(
            on_again_text.starts_with(BULLET),
            "tick {} should show bullet again",
            BLINK_INTERVAL_TICKS * 2
        );
    }

    #[test]
    fn resolved_bullet_ignores_spinner_tick() {
        // Ok / Error render solid regardless of the animation clock.
        let args = serde_json::json!({});
        for status in [ToolStatus::Ok, ToolStatus::Error] {
            let view = ToolCallView {
                name: "Bash",
                args: &args,
                status,
                elapsed_ms: Some(10),
                payload: None,
                verbose: false,
                spinner_tick: BLINK_INTERVAL_TICKS, // would blink if Running
            };
            let text = collect_text(&render_tool_call(&view));
            assert!(
                text.starts_with(BULLET),
                "{status:?} must render solid bullet at any tick"
            );
        }
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
                    verbose: false,
                    spinner_tick: 0,
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
                    verbose: false,
                    spinner_tick: 0,
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
                    verbose: false,
                    spinner_tick: 0,
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
        let payload = payload_from_result("TodoWrite", &value, false).expect("todos payload");
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
        let payload = payload_from_result("Read", &value, false).expect("preview");
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
        let payload = payload_from_result("Glob", &value, false).expect("preview");
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
        let payload = payload_from_result("Edit", &value, false).expect("diff");
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

    fn expect_bash(p: ToolPayload) -> (String, String, i64) {
        match p {
            ToolPayload::Bash { stdout, stderr, exit_code } => (stdout, stderr, exit_code),
            other => panic!("expected Bash, got {other:?}"),
        }
    }

    #[test]
    fn payload_from_result_bash_splits_streams() {
        let v = serde_json::json!({
            "status": "ok",
            "exit_code": 0,
            "stdout": "hello",
            "stderr": "",
            "elapsed_ms": 2,
        });
        let (stdout, stderr, exit) = expect_bash(
            payload_from_result("Bash", &v, false).expect("bash payload"),
        );
        assert_eq!(stdout, "hello");
        assert!(stderr.is_empty());
        assert_eq!(exit, 0);
    }

    #[test]
    fn payload_from_result_bash_surfaces_stderr_only() {
        let v = serde_json::json!({
            "status": "ok",
            "exit_code": 2,
            "stdout": "",
            "stderr": "bad thing happened",
        });
        let (stdout, stderr, exit) = expect_bash(
            payload_from_result("Bash", &v, false).expect("bash payload"),
        );
        assert!(stdout.is_empty());
        assert!(stderr.contains("bad thing happened"));
        assert_eq!(exit, 2);
    }

    #[test]
    fn payload_from_result_bash_empty_streams_show_no_output() {
        let v = serde_json::json!({
            "status": "ok",
            "exit_code": 0,
            "stdout": "",
            "stderr": "",
        });
        let (stdout, stderr, _) = expect_bash(
            payload_from_result("Bash", &v, false).expect("bash payload"),
        );
        assert_eq!(stdout, "(No output)");
        assert!(stderr.is_empty());
    }

    #[test]
    fn payload_from_result_bash_legacy_output_on_success_maps_to_stdout() {
        // Backward compat: transcripts written before the split only
        // carried `output`. Dispatcher is gone but captured sessions
        // still replay through the render path.
        let v = serde_json::json!({
            "status": "ok",
            "exit_code": 0,
            "output": "line-one\nline-two",
        });
        let (stdout, stderr, _) = expect_bash(
            payload_from_result("Bash", &v, false).expect("bash payload"),
        );
        assert!(stdout.contains("line-one"));
        assert!(stderr.is_empty());
    }

    #[test]
    fn payload_from_result_bash_legacy_output_on_failure_maps_to_stderr() {
        let v = serde_json::json!({
            "status": "ok",
            "exit_code": 1,
            "output": "command not found",
        });
        let (stdout, stderr, exit) = expect_bash(
            payload_from_result("Bash", &v, false).expect("bash payload"),
        );
        assert!(stdout.is_empty());
        assert!(stderr.contains("command not found"));
        assert_eq!(exit, 1);
    }

    #[test]
    fn render_tool_call_bash_stderr_paints_error_color() {
        let args = serde_json::json!({"command": "oops"});
        let payload = ToolPayload::Bash {
            stdout: String::from("ok line"),
            stderr: String::from("err line"),
            exit_code: 1,
        };
        let view = ToolCallView {
            name: "Bash",
            args: &args,
            status: ToolStatus::Error,
            elapsed_ms: Some(10),
            payload: Some(&payload),
            verbose: false,
            spinner_tick: 0,
        };
        let lines = render_tool_call(&view);
        // Find the stderr line and confirm its text span carries ERROR color.
        let err_line = lines
            .iter()
            .find(|l| {
                l.spans
                    .iter()
                    .any(|s| s.content.as_ref() == "err line")
            })
            .expect("stderr line rendered");
        let text_span = err_line
            .spans
            .iter()
            .find(|s| s.content.as_ref() == "err line")
            .unwrap();
        assert_eq!(text_span.style.fg, Some(theme::ERROR));
        // And the stdout line should carry MUTED.
        let ok_line = lines
            .iter()
            .find(|l| {
                l.spans
                    .iter()
                    .any(|s| s.content.as_ref() == "ok line")
            })
            .expect("stdout line rendered");
        let ok_span = ok_line
            .spans
            .iter()
            .find(|s| s.content.as_ref() == "ok line")
            .unwrap();
        assert_eq!(ok_span.style.fg, Some(theme::MUTED));
    }

    #[test]
    fn summarize_args_read_renders_file_path_and_window() {
        let a = serde_json::json!({"file_path": "/tmp/x.rs", "offset": 10, "limit": 50});
        let out = summarize_args("Read", &a, false);
        // Upstream shape: `<displayPath> · lines <a>-<b>` —
        // middot-joined qualifier, bare path.
        assert!(out.starts_with("/tmp/x.rs"), "got: {out}");
        assert!(out.contains(" · lines 10-59"), "got: {out}");
    }

    #[test]
    fn summarize_args_read_pages_supersedes_window() {
        let a = serde_json::json!({"file_path": "/tmp/doc.pdf", "pages": "1-5", "offset": 10});
        let out = summarize_args("Read", &a, false);
        assert!(out.starts_with("/tmp/doc.pdf"), "got: {out}");
        assert!(out.contains(" · pages 1-5"), "got: {out}");
        assert!(
            !out.contains("line") && !out.contains("offset"),
            "pages should suppress offset/lines: {out}"
        );
    }

    #[test]
    fn summarize_args_skill_is_bare() {
        let a = serde_json::json!({"skill": "verifier-tui", "args": "flag=1"});
        let out = summarize_args("Skill", &a, false);
        assert_eq!(out, "verifier-tui");
    }

    #[test]
    fn summarize_args_agent_is_bare_description() {
        let a = serde_json::json!({"description": "Audit ship-readiness", "prompt": "long…"});
        let out = summarize_args("Agent", &a, false);
        assert_eq!(out, "Audit ship-readiness");
    }

    #[test]
    fn summarize_args_tool_search_is_hidden() {
        let a = serde_json::json!({"query": "slack", "max_results": 5});
        let out = summarize_args("ToolSearch", &a, false);
        assert_eq!(out, "");
    }

    #[test]
    fn summarize_args_glob_grep_emit_pattern_and_path() {
        // Upstream quotes both values and uses `: ` separator.
        let a = serde_json::json!({"pattern": "*.rs", "path": "/tmp"});
        assert!(summarize_args("Glob", &a, false).contains(r#"pattern: "*.rs""#));
        assert!(summarize_args("Glob", &a, false).contains(r#"path: "/tmp""#));
        assert!(summarize_args("Grep", &a, false).contains(r#"pattern: "*.rs""#));
    }

    #[test]
    fn payload_from_result_read_lines_summary() {
        let v = serde_json::json!({
            "content": "     1\talpha\n     2\tbeta",
            "numLines": 2,
            "startLine": 1,
            "totalLines": 2,
        });
        let s = expect_preview(payload_from_result("Read", &v, false).unwrap());
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
        let s = expect_preview(payload_from_result("Read", &v, false).unwrap());
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
        let s = expect_preview(payload_from_result("Write", &v, false).unwrap());
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
        let s = expect_preview(payload_from_result("Write", &v, false).unwrap());
        assert!(s.starts_with("Wrote 1 byte "), "singular: {s}");
    }

    #[test]
    fn payload_from_result_edit_without_diff_shows_replaced() {
        let v = serde_json::json!({
            "status": "ok",
            "file_path": "/tmp/x.rs",
            "replaced": 3,
        });
        let s = expect_preview(payload_from_result("Edit", &v, false).unwrap());
        assert!(s.contains("3 replacements"), "got: {s}");
        assert!(s.contains("/tmp/x.rs"), "got: {s}");
    }

    #[test]
    fn payload_from_result_glob_compact_is_head_only() {
        // Non-verbose mirrors upstream GlobTool/UI.tsx — head count,
        // no filename list. Reader uses `/verbose` to expand.
        let v = serde_json::json!({
            "numFiles": 2,
            "filenames": ["/a.rs", "/b.rs"],
            "truncated": false,
            "durationMs": 12,
        });
        let s = expect_preview(payload_from_result("Glob", &v, false).unwrap());
        assert_eq!(s, "Found 2 files");
    }

    #[test]
    fn payload_from_result_glob_verbose_adds_file_list() {
        let v = serde_json::json!({
            "numFiles": 2,
            "filenames": ["/a.rs", "/b.rs"],
            "truncated": false,
            "durationMs": 12,
        });
        let s = expect_preview(payload_from_result("Glob", &v, true).unwrap());
        assert!(s.starts_with("Found 2 files\n"), "got: {s}");
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
        let s = expect_preview(payload_from_result("Glob", &v, false).unwrap());
        assert_eq!(s, "Found 1 file");
    }

    #[test]
    fn payload_from_result_grep_default_mode_files_compact() {
        let v = serde_json::json!({
            "mode": "files_with_matches",
            "matches": ["/a.rs", "/b.rs", "/c.rs"],
            "truncated": false,
            "exit": 0,
        });
        let s = expect_preview(payload_from_result("Grep", &v, false).unwrap());
        assert_eq!(s, "Found 3 matches");
    }

    #[test]
    fn payload_from_result_grep_default_mode_files_verbose() {
        let v = serde_json::json!({
            "mode": "files_with_matches",
            "matches": ["/a.rs", "/b.rs", "/c.rs"],
            "truncated": false,
            "exit": 0,
        });
        let s = expect_preview(payload_from_result("Grep", &v, true).unwrap());
        assert!(s.starts_with("Found 3 matches\n"), "got: {s}");
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
        let s = expect_preview(payload_from_result("Grep", &v, false).unwrap());
        assert!(s.starts_with("Found 2 lines"), "got: {s}");
    }

    #[test]
    fn payload_from_result_skill_shows_byline() {
        // Upstream `Successfully loaded skill · N tools allowed · model`.
        let v = serde_json::json!({
            "skill": "verifier-tui",
            "tools": ["Read", "Glob", "Bash"],
            "model": "claude-sonnet-4-6",
        });
        let s = expect_preview(payload_from_result("Skill", &v, false).unwrap());
        assert!(
            s.starts_with("Successfully loaded skill"),
            "got: {s}"
        );
        assert!(s.contains("3 tools allowed"), "got: {s}");
        assert!(s.contains("claude-sonnet-4-6"), "got: {s}");
        assert!(s.contains(" · "), "segments must middot-join: {s}");
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
        let s = expect_preview(payload_from_result("ToolSearch", &v, false).unwrap());
        assert!(s.contains("Found 2 tools"), "got: {s}");
        assert!(s.contains("Read"), "got: {s}");
        assert!(s.contains("ReadFoo"), "got: {s}");
    }

    #[test]
    fn payload_from_result_tool_search_empty_reports_zero() {
        let v = serde_json::json!({"query": "zz", "max_results": 5, "tools": []});
        let s = expect_preview(payload_from_result("ToolSearch", &v, false).unwrap());
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
        let s = expect_preview(payload_from_result("Agent", &v, false).unwrap());
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
        let s = expect_preview(payload_from_result("Agent", &v, false).unwrap());
        assert!(s.starts_with("Done ("), "got: {s}");
        assert!(s.contains("5 tool uses"), "got: {s}");
        assert!(s.contains("12,345 tokens"), "got: {s}");
        assert!(s.contains("2m 15s"), "got: {s}");
    }
}
