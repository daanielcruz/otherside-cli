

use std::hash::{DefaultHasher, Hash, Hasher};

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;

use super::render::theme;
use super::{diff, todos};

#[cfg(target_os = "macos")]
const BULLET: &str = "⏺";
#[cfg(not(target_os = "macos"))]
const BULLET: &str = "●";

const BULLET_HIDDEN: &str = " ";

const BLINK_INTERVAL_TICKS: u64 = 12;

const MAX_PROGRESS_MESSAGES_TO_SHOW: usize = 3;

const TURN_COMPLETION_VERBS: &[&str] = &[
    "Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked",
];

fn pick_turn_completion_verb(args: &Value, elapsed_ms: u64) -> &'static str {
    let mut h = DefaultHasher::new();
    args.to_string().hash(&mut h);
    elapsed_ms.hash(&mut h);
    let idx = (h.finish() as usize) % TURN_COMPLETION_VERBS.len();
    TURN_COMPLETION_VERBS[idx]
}

fn relativize_path(fp: &str) -> String {
    if fp.is_empty() || fp.starts_with('~') {
        return fp.to_string();
    }
    let Ok(cwd) = std::env::current_dir() else {
        return fp.to_string();
    };
    let Some(cwd_str) = cwd.to_str() else {
        return fp.to_string();
    };
    if let Some(rest) = fp.strip_prefix(cwd_str) {
        let trimmed = rest.trim_start_matches('/');
        if trimmed.is_empty() {
            return ".".to_string();
        }
        return trimmed.to_string();
    }
    fp.to_string()
}

pub fn format_number_compact(n: u64) -> String {
    if n < 1_000 {
        return n.to_string();
    }
    const UNITS: &[(u64, &str)] = &[
        (1_000_000_000_000, "t"),
        (1_000_000_000, "b"),
        (1_000_000, "m"),
        (1_000, "k"),
    ];
    for (i, &(div, suffix)) in UNITS.iter().enumerate() {
        if n >= div {
            let scaled = n as f64 / div as f64;
            let rounded = (scaled * 10.0).round() / 10.0;
            if rounded >= 1000.0 && i > 0 {
                let (pdiv, psuffix) = UNITS[i - 1];
                let pscaled = n as f64 / pdiv as f64;
                let prounded = (pscaled * 10.0).round() / 10.0;
                if prounded.fract() == 0.0 {
                    return format!("{}{}", prounded as u64, psuffix);
                }
                return format!("{:.1}{}", prounded, psuffix);
            }
            if rounded.fract() == 0.0 {
                return format!("{}{}", rounded as u64, suffix);
            }
            return format!("{:.1}{}", rounded, suffix);
        }
    }
    unreachable!()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ToolStatus {
    Running,
    Ok,
    Error,
}

impl ToolStatus {

    pub(crate) fn color(self) -> ratatui::style::Color {
        match self {

            ToolStatus::Running => theme::MUTED,
            ToolStatus::Ok => theme::SUCCESS,
            ToolStatus::Error => theme::ERROR,
        }
    }

    pub(crate) fn modifier(self) -> ratatui::style::Modifier {
        use ratatui::style::Modifier;
        let _ = self;
        Modifier::BOLD
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ToolPayload {

    Preview(String),

    Todos(Vec<todos::TodoItem>),

    Diff(String),

    Bash {
        stdout: String,
        stderr: String,
        exit_code: i64,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolCallArchive {
    pub status: ToolStatus,
    pub name: String,
    pub elapsed_ms: u64,
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<ToolPayload>,

    #[serde(default)]
    pub id: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_result: Option<Value>,
}

impl ToolCallArchive {

    pub fn view(&self) -> ToolCallView<'_> {
        ToolCallView {
            name: &self.name,
            args: &self.args,
            status: self.status,
            elapsed_ms: Some(self.elapsed_ms),
            payload: self.payload.as_ref(),

            verbose: false,

            spinner_tick: 0,

            nested_entries: &[],
        }
    }
}

#[derive(Debug, Clone)]
pub struct NestedEntry {
    pub tool_name: String,
    pub args: Value,
    pub running: bool,
}

fn user_facing_tool_name(tool_name: &str, args: &Value) -> String {
    if tool_name == "Agent" {
        if let Some(sub) = args
            .as_object()
            .and_then(|o| o.get("subagent_type"))
            .and_then(|v| v.as_str())
        {
            if sub != "general-purpose" && sub != "worker" {
                return sub.to_string();
            }
        }
    }
    tool_name.to_string()
}

pub struct ToolCallView<'a> {
    pub name: &'a str,
    pub args: &'a Value,
    pub status: ToolStatus,
    pub elapsed_ms: Option<u64>,
    pub payload: Option<&'a ToolPayload>,

    pub verbose: bool,

    pub spinner_tick: u64,

    pub nested_entries: &'a [NestedEntry],
}

pub fn render_tool_call(view: &ToolCallView<'_>) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();

    let displayed_name: String = user_facing_tool_name(view.name, view.args);
    let arg_summary = summarize_args(view.name, view.args, view.verbose);
    let parens = if arg_summary.is_empty() {
        String::new()
    } else {
        format!("({arg_summary})")
    };

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
    let _ = view.elapsed_ms;
    out.push(Line::from(header_spans));

    const GUTTER_HEAD: &str = "  ⎿  ";
    const GUTTER_CONT: &str = "     ";

    if view.name == "Agent"
        && matches!(view.status, ToolStatus::Running)
        && view.nested_entries.is_empty()
    {
        out.push(Line::from(vec![
            Span::styled(GUTTER_HEAD.to_string(), Style::default().fg(theme::MUTED)),
            Span::styled(
                "Initializing…".to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ]));
    }

    let nested_count = view.nested_entries.len();
    let hidden = nested_count.saturating_sub(MAX_PROGRESS_MESSAGES_TO_SHOW);
    let visible_start = nested_count.saturating_sub(MAX_PROGRESS_MESSAGES_TO_SHOW);
    for (rel_idx, entry) in view.nested_entries.iter().skip(visible_start).enumerate() {
        let (label, inner) = format_nested_entry(entry);
        let prefix = if rel_idx == 0 { GUTTER_HEAD } else { GUTTER_CONT };
        let mut spans: Vec<Span<'static>> = Vec::with_capacity(4);
        spans.push(Span::styled(
            prefix.to_string(),
            Style::default().fg(theme::MUTED),
        ));
        spans.push(Span::styled(
            label.clone(),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        ));
        if !inner.is_empty() {
            spans.push(Span::styled(
                format!("({inner})"),
                Style::default().fg(theme::MUTED),
            ));
        }
        out.push(Line::from(spans));

        let abs_idx = visible_start + rel_idx;
        let is_last = abs_idx + 1 == nested_count;
        if is_last && entry.running {
            out.push(Line::from(vec![
                Span::styled(GUTTER_CONT.to_string(), Style::default().fg(theme::MUTED)),
                Span::styled("Running…".to_string(), Style::default().fg(theme::MUTED)),
            ]));
        }
    }
    if hidden > 0 {
        let plural = if hidden == 1 { "use" } else { "uses" };
        out.push(Line::from(vec![
            Span::styled(GUTTER_CONT.to_string(), Style::default().fg(theme::MUTED)),
            Span::styled(
                format!("+{hidden} more tool {plural} (ctrl+o to expand)"),
                Style::default().fg(theme::MUTED),
            ),
        ]));
    }


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

pub fn summarize_args(name: &str, args: &Value, verbose: bool) -> String {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    if obj.is_empty() {
        return String::new();
    }

    let _ = verbose;

    if matches!(
        name,
        "ToolSearch" | "TaskCreate" | "TaskList" | "TaskGet" | "TaskUpdate"
    ) {
        return String::new();
    }

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

    if name == "Read" {
        if let Some(fp) = obj.get("file_path").and_then(|v| v.as_str()) {
            let mut header = clip_flat(&relativize_path(fp), 80);
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

    if name == "Edit" || name == "Write" {
        if let Some(fp) = obj.get("file_path").and_then(|v| v.as_str()) {
            return clip_flat(&relativize_path(fp), 80);
        }
    }

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

    if name == "WebFetch" {
        if let Some(u) = obj.get("url").and_then(|v| v.as_str()) {
            return clip_flat(u, 100);
        }
    }

    if name == "WebSearch" {
        if let Some(q) = obj.get("query").and_then(|v| v.as_str()) {
            return format!("\"{}\"", clip_flat(q, 100));
        }
    }

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

pub fn payload_from_result(
    name: &str,
    result: &Value,
    verbose: bool,
    args: &Value,
) -> Option<ToolPayload> {
    match name {
        "TodoWrite" => todos_payload(result),
        "Edit" => diff_payload(result).or_else(|| edit_preview(result)),
        "Write" => diff_payload(result).or_else(|| write_preview(result, args)),
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

pub fn payload_from_error(err: &str) -> ToolPayload {
    ToolPayload::Preview(one_line_preview(err, 240))
}

fn todos_payload(result: &Value) -> Option<ToolPayload> {

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

fn read_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;

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

fn edit_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let raw_fp = obj.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
    let fp = relativize_path(raw_fp);
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

const WRITE_MAX_LINES_TO_RENDER: usize = 10;

fn write_preview(result: &Value, args: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let raw_fp = obj
        .get("file_path")
        .and_then(|v| v.as_str())
        .or_else(|| args.get("file_path").and_then(|v| v.as_str()))
        .unwrap_or("");
    let fp = relativize_path(raw_fp);

    let args_content = args.get("content").and_then(|v| v.as_str());
    let lines = obj
        .get("numLines")
        .or_else(|| obj.get("lines"))
        .and_then(|v| v.as_u64())
        .or_else(|| args_content.map(|s| count_lines(s) as u64));
    let bytes = obj.get("bytes_written").and_then(|v| v.as_u64());
    let verb = "Wrote";
    let header = match (lines, bytes, fp.is_empty()) {
        (Some(n), _, false) => format!("{verb} {n} lines to {fp}"),
        (Some(n), _, true) => format!("{verb} {n} lines"),
        (None, Some(n), false) => format!(
            "{verb} {n} byte{} to {fp}",
            if n == 1 { "" } else { "s" }
        ),
        (None, Some(n), true) => format!("{verb} {n} bytes"),
        (None, None, false) => format!("{verb} {fp}"),
        (None, None, true) => return None,
    };

    let body = args_content.unwrap_or("");
    if body.is_empty() {
        return Some(ToolPayload::Preview(header));
    }
    let total = count_lines(body);
    let preview_lines: Vec<&str> = body.split('\n').take(WRITE_MAX_LINES_TO_RENDER).collect();
    let preview = preview_lines.join("\n");
    let plus = total.saturating_sub(WRITE_MAX_LINES_TO_RENDER);
    let mut text = header;
    text.push('\n');
    text.push_str(&preview);
    if plus > 0 {
        text.push('\n');
        text.push_str(&format!(
            "… +{plus} {}",
            if plus == 1 { "line" } else { "lines" }
        ));
    }
    Some(ToolPayload::Preview(text))
}

fn count_lines(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    let parts = content.split('\n').count();
    if content.ends_with('\n') {
        parts - 1
    } else {
        parts
    }
}

fn bash_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let stdout = obj.get("stdout").and_then(|v| v.as_str()).map(str::to_string);
    let stderr = obj.get("stderr").and_then(|v| v.as_str()).map(str::to_string);
    let legacy = obj.get("output").and_then(|v| v.as_str()).map(str::to_string);
    if stdout.is_none() && stderr.is_none() && legacy.is_none() {
        return None;
    }
    let exit = obj.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(0);

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

fn web_search_preview(result: &Value) -> Option<ToolPayload> {
    let obj = result.as_object()?;
    let results = obj.get("results").and_then(|v| v.as_array())?;

    if results.len() == 1 {
        if let Some(s) = results[0].as_str() {
            if s.starts_with("web_search_unavailable") {
                return Some(ToolPayload::Preview(one_line_preview(s, 240)));
            }
        }
    }

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
            "Done ({} tool use{} · {} tokens · {})\n(ctrl+o to expand)",
            tool_uses,
            if tool_uses == 1 { "" } else { "s" },
            format_number_compact(tokens),
            format_duration_ms(duration_ms),
        )));
    }

    if status == "backgrounded" {
        return Some(ToolPayload::Preview(
            "Backgrounded agent (↓ to manage · ctrl+o to expand)".to_string(),
        ));
    }

    let reason = obj
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("agent dispatch returned no result");
    Some(ToolPayload::Preview(one_line_preview(reason, 240)))
}

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

                let trimmed = trim_multiline(output, 20, 200);
                return Some(ToolPayload::Preview(format!("{prefix}{trimmed}")));
            }
            if let Some(s) = obj.get("content").and_then(|v| v.as_str()) {
                return Some(ToolPayload::Preview(one_line_preview(s, 240)));
            }

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

pub fn format_nested_entry(entry: &NestedEntry) -> (String, String) {
    let label = nested_display_name(&entry.tool_name);
    let inner = summarize_args(&entry.tool_name, &entry.args, false);
    (label, inner)
}

fn nested_display_name(tool_name: &str) -> String {
    match tool_name {
        "Glob" => "Search".to_string(),
        other => other.to_string(),
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
            nested_entries: &[],
        };
        let lines = render_tool_call(&view);
        let text = collect_text(&lines);

        assert!(text.contains("Read"));
        assert!(text.contains("/tmp/x.rs"));
        assert!(!text.contains("file_path="));
        assert!(!text.contains(" ok "));
        assert!(!text.contains("1s"));
    }

    #[test]
    fn running_bullet_alternates_with_spinner_tick() {

        let args = serde_json::json!({});
        let mk_view = |tick: u64| ToolCallView {
            name: "Bash",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: tick,
            nested_entries: &[],
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

        let args = serde_json::json!({});
        for status in [ToolStatus::Ok, ToolStatus::Error] {
            let view = ToolCallView {
                name: "Bash",
                args: &args,
                status,
                elapsed_ms: Some(10),
                payload: None,
                verbose: false,
                spinner_tick: BLINK_INTERVAL_TICKS,
                nested_entries: &[],
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
            nested_entries: &[],
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
            nested_entries: &[],
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
            nested_entries: &[],
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
        let payload = payload_from_result("TodoWrite", &value, false, &serde_json::Value::Null).expect("todos payload");
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
        let payload = payload_from_result("Read", &value, false, &serde_json::Value::Null).expect("preview");
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
        let payload = payload_from_result("Glob", &value, false, &serde_json::Value::Null).expect("preview");
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
        let payload = payload_from_result("Edit", &value, false, &serde_json::Value::Null).expect("diff");
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
            payload_from_result("Bash", &v, false, &serde_json::Value::Null).expect("bash payload"),
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
            payload_from_result("Bash", &v, false, &serde_json::Value::Null).expect("bash payload"),
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
            payload_from_result("Bash", &v, false, &serde_json::Value::Null).expect("bash payload"),
        );
        assert_eq!(stdout, "(No output)");
        assert!(stderr.is_empty());
    }

    #[test]
    fn payload_from_result_bash_legacy_output_on_success_maps_to_stdout() {

        let v = serde_json::json!({
            "status": "ok",
            "exit_code": 0,
            "output": "line-one\nline-two",
        });
        let (stdout, stderr, _) = expect_bash(
            payload_from_result("Bash", &v, false, &serde_json::Value::Null).expect("bash payload"),
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
            payload_from_result("Bash", &v, false, &serde_json::Value::Null).expect("bash payload"),
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
            nested_entries: &[],
        };
        let lines = render_tool_call(&view);

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
        let s = expect_preview(payload_from_result("Read", &v, false, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Read", &v, false, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Write", &v, false, &serde_json::Value::Null).unwrap());
        assert!(s.contains("Wrote"), "got: {s}");
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
        let s = expect_preview(payload_from_result("Write", &v, false, &serde_json::Value::Null).unwrap());
        assert!(s.starts_with("Wrote 1 byte "), "singular: {s}");
    }

    #[test]
    fn write_preview_embeds_first_10_lines_of_content_from_args() {
        let body = (1..=15)
            .map(|n| format!("line{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let args = serde_json::json!({
            "file_path": "/tmp/fifteen.txt",
            "content": body,
        });
        let result = serde_json::json!({
            "status": "ok",
            "file_path": "/tmp/fifteen.txt",
        });
        let s = expect_preview(payload_from_result("Write", &result, false, &args).unwrap());
        let lines: Vec<&str> = s.lines().collect();
        assert!(lines[0].contains("Wrote 15 lines to"), "header: {s}");
        assert_eq!(lines[1], "line1");
        assert_eq!(lines[10], "line10", "cut at 10 lines: {s}");
        assert_eq!(lines[11], "… +5 lines", "plus indicator: {s}");
    }

    #[test]
    fn write_preview_no_plus_indicator_under_10_lines() {
        let body = "only\ntwo".to_string();
        let args = serde_json::json!({
            "file_path": "/tmp/short.txt",
            "content": body,
        });
        let result = serde_json::json!({ "file_path": "/tmp/short.txt" });
        let s = expect_preview(payload_from_result("Write", &result, false, &args).unwrap());
        assert!(!s.contains("… +"), "no plus when under 10: {s}");
        assert!(s.contains("Wrote 2 lines"), "header infers from content: {s}");
        assert!(s.contains("only"), "body included: {s}");
    }

    #[test]
    fn write_preview_singular_line_wording() {
        let args = serde_json::json!({
            "file_path": "/tmp/x.txt",
            "content": "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven",
        });
        let result = serde_json::json!({ "file_path": "/tmp/x.txt" });
        let s = expect_preview(payload_from_result("Write", &result, false, &args).unwrap());
        assert!(s.contains("… +1 line"), "singular plus: {s}");
    }

    #[test]
    fn payload_from_result_edit_without_diff_shows_replaced() {
        let v = serde_json::json!({
            "status": "ok",
            "file_path": "/tmp/x.rs",
            "replaced": 3,
        });
        let s = expect_preview(payload_from_result("Edit", &v, false, &serde_json::Value::Null).unwrap());
        assert!(s.contains("3 replacements"), "got: {s}");
        assert!(s.contains("/tmp/x.rs"), "got: {s}");
    }

    #[test]
    fn payload_from_result_glob_compact_is_head_only() {

        let v = serde_json::json!({
            "numFiles": 2,
            "filenames": ["/a.rs", "/b.rs"],
            "truncated": false,
            "durationMs": 12,
        });
        let s = expect_preview(payload_from_result("Glob", &v, false, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Glob", &v, true, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Glob", &v, false, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Grep", &v, false, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Grep", &v, true, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Grep", &v, false, &serde_json::Value::Null).unwrap());
        assert!(s.starts_with("Found 2 lines"), "got: {s}");
    }

    #[test]
    fn payload_from_result_skill_shows_byline() {

        let v = serde_json::json!({
            "skill": "verifier-tui",
            "tools": ["Read", "Glob", "Bash"],
            "model": "claude-sonnet-4-6",
        });
        let s = expect_preview(payload_from_result("Skill", &v, false, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("ToolSearch", &v, false, &serde_json::Value::Null).unwrap());
        assert!(s.contains("Found 2 tools"), "got: {s}");
        assert!(s.contains("Read"), "got: {s}");
        assert!(s.contains("ReadFoo"), "got: {s}");
    }

    #[test]
    fn payload_from_result_tool_search_empty_reports_zero() {
        let v = serde_json::json!({"query": "zz", "max_results": 5, "tools": []});
        let s = expect_preview(payload_from_result("ToolSearch", &v, false, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Agent", &v, false, &serde_json::Value::Null).unwrap());
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
        let s = expect_preview(payload_from_result("Agent", &v, false, &serde_json::Value::Null).unwrap());
        assert!(s.starts_with("Done ("), "got: {s}");
        assert!(s.contains("5 tool uses"), "got: {s}");
        assert!(s.contains("12.3k tokens"), "got: {s}");
        assert!(s.contains("2m 15s"), "got: {s}");
    }

    #[test]
    fn format_number_compact_matches_upstream_compact_notation() {
        assert_eq!(format_number_compact(0), "0");
        assert_eq!(format_number_compact(900), "900");
        assert_eq!(format_number_compact(999), "999");
        assert_eq!(format_number_compact(1_000), "1k");
        assert_eq!(format_number_compact(1_300), "1.3k");
        assert_eq!(format_number_compact(10_000), "10k");
        assert_eq!(format_number_compact(12_345), "12.3k");
        assert_eq!(format_number_compact(42_500), "42.5k");
        assert_eq!(format_number_compact(79_070), "79.1k");
        assert_eq!(format_number_compact(1_000_000), "1m");
        assert_eq!(format_number_compact(1_500_000), "1.5m");
    }

    #[test]
    fn pick_turn_completion_verb_is_stable_per_input_and_from_pool() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"foo"});
        let v1 = pick_turn_completion_verb(&args, 12_000);
        let v2 = pick_turn_completion_verb(&args, 12_000);
        assert_eq!(v1, v2);
        assert!(TURN_COMPLETION_VERBS.contains(&v1));
    }

    #[test]
    fn pick_turn_completion_verb_covers_pool_across_inputs() {
        use std::collections::HashSet;
        let mut seen: HashSet<&'static str> = HashSet::new();
        for i in 0..64u64 {
            let args = serde_json::json!({"subagent_type": format!("t{i}"), "description": format!("d{i}")});
            seen.insert(pick_turn_completion_verb(&args, i * 100));
        }
        assert!(
            seen.len() >= 4,
            "verb pool coverage too low — only {} distinct verbs across 64 inputs",
            seen.len()
        );
    }

    #[test]
    fn agent_backgrounded_preview_matches_upstream_string() {
        let v = serde_json::json!({"status":"backgrounded"});
        let s = expect_preview(payload_from_result("Agent", &v, false, &serde_json::Value::Null).unwrap());
        assert_eq!(
            s,
            "Backgrounded agent (↓ to manage · ctrl+o to expand)"
        );
    }

    #[test]
    fn agent_running_with_no_nested_shows_initializing_placeholder() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"do x"});
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &[],
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(
            text.contains("Initializing…"),
            "expected Initializing placeholder while Agent is running without nested progress: {text:?}"
        );
    }

    #[test]
    fn agent_running_with_nested_skips_initializing_placeholder() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"do x"});
        let nested = vec![NestedEntry {
            tool_name: "Bash".to_string(),
            args: serde_json::json!({"command": "ls"}),
            running: true,
        }];
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(
            !text.contains("Initializing"),
            "Initializing must disappear once progress arrives: {text:?}"
        );
    }

    #[test]
    fn nested_glob_renders_as_search() {
        let entry = NestedEntry {
            tool_name: "Glob".to_string(),
            args: serde_json::json!({"pattern": "*.rs"}),
            running: true,
        };
        let (label, _) = format_nested_entry(&entry);
        assert_eq!(label, "Search");
    }

    #[test]
    fn nested_bash_carries_command_in_parens() {
        let entry = NestedEntry {
            tool_name: "Bash".to_string(),
            args: serde_json::json!({"command": "git status"}),
            running: true,
        };
        let (label, inner) = format_nested_entry(&entry);
        assert_eq!(label, "Bash");
        assert!(inner.contains("git status"));
    }

    #[test]
    fn nested_running_line_only_under_last_entry_when_running() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"x"});
        let nested = vec![
            NestedEntry {
                tool_name: "Bash".to_string(),
                args: serde_json::json!({"command": "echo 1"}),
                running: false,
            },
            NestedEntry {
                tool_name: "Read".to_string(),
                args: serde_json::json!({"file_path": "/tmp/a.rs"}),
                running: true,
            },
        ];
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert_eq!(
            text.matches("Running…").count(),
            1,
            "Running… must render once, under last unresolved entry: {text:?}"
        );
    }

    #[test]
    fn nested_running_line_absent_when_all_resolved() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"x"});
        let nested = vec![NestedEntry {
            tool_name: "Bash".to_string(),
            args: serde_json::json!({"command": "ls"}),
            running: false,
        }];
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(!text.contains("Running…"));
    }

    #[test]
    fn nested_truncates_to_max_3_and_emits_plus_n_suffix() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"x"});
        let nested: Vec<NestedEntry> = (0..5)
            .map(|i| NestedEntry {
                tool_name: "Bash".to_string(),
                args: serde_json::json!({"command": format!("echo {i}")}),
                running: false,
            })
            .collect();
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(
            text.contains("+2 more tool uses (ctrl+o to expand)"),
            "expected +2 more suffix with plural + ctrl+o hint: {text:?}"
        );
        assert!(!text.contains("echo 0"), "first two entries should be hidden");
        assert!(!text.contains("echo 1"), "first two entries should be hidden");
        assert!(text.contains("echo 2"));
        assert!(text.contains("echo 3"));
        assert!(text.contains("echo 4"));
    }

    #[test]
    fn nested_plus_one_uses_singular_form() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"x"});
        let nested: Vec<NestedEntry> = (0..4)
            .map(|i| NestedEntry {
                tool_name: "Bash".to_string(),
                args: serde_json::json!({"command": format!("cmd{i}")}),
                running: false,
            })
            .collect();
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(text.contains("+1 more tool use (ctrl+o to expand)"));
        assert!(!text.contains("+1 more tool uses"));
    }

    #[test]
    fn agent_running_does_not_emit_inline_ctrl_b_hint() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"x"});
        let nested = vec![NestedEntry {
            tool_name: "Bash".to_string(),
            args: serde_json::json!({"command": "ls"}),
            running: false,
        }];
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: Some(1500),
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(
            !text.contains("(ctrl+b"),
            "Agent block must not emit inline ctrl+b hint (upstream keeps it in prompt footer): {text:?}"
        );
    }

    #[test]
    fn non_agent_tool_does_not_emit_ctrl_b_hint() {
        let args = serde_json::json!({"command": "ls"});
        let view = ToolCallView {
            name: "Bash",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: Some(500),
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &[],
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(!text.contains("(ctrl+b"));
    }

    #[test]
    fn resolved_agent_does_not_emit_ctrl_b_hint() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"x"});
        let nested = vec![NestedEntry {
            tool_name: "Bash".to_string(),
            args: serde_json::json!({"command": "ls"}),
            running: false,
        }];
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Ok,
            elapsed_ms: Some(1500),
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(!text.contains("(ctrl+b"));
    }

    #[test]
    fn nested_no_suffix_when_under_cap() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"x"});
        let nested: Vec<NestedEntry> = (0..2)
            .map(|i| NestedEntry {
                tool_name: "Bash".to_string(),
                args: serde_json::json!({"command": format!("cmd{i}")}),
                running: false,
            })
            .collect();
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(!text.contains("more tool"));
    }

    #[test]
    fn nested_gutter_emits_once_for_multi_entry_block() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"x"});
        let nested = vec![
            NestedEntry {
                tool_name: "Bash".to_string(),
                args: serde_json::json!({"command": "echo 1"}),
                running: false,
            },
            NestedEntry {
                tool_name: "Read".to_string(),
                args: serde_json::json!({"file_path": "/tmp/a.rs"}),
                running: false,
            },
            NestedEntry {
                tool_name: "Grep".to_string(),
                args: serde_json::json!({"pattern": "TODO"}),
                running: false,
            },
        ];
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &nested,
        };
        let text = collect_text(&render_tool_call(&view));
        assert_eq!(
            text.matches("⎿ ").count(),
            1,
            "⎿ gutter must only render on the first nested entry: {text:?}"
        );
    }

    #[test]
    fn agent_tool_header_does_not_emit_dispatching_line() {
        let args = serde_json::json!({"subagent_type":"general-purpose","description":"foo"});
        let view = ToolCallView {
            name: "Agent",
            args: &args,
            status: ToolStatus::Running,
            elapsed_ms: None,
            payload: None,
            verbose: false,
            spinner_tick: 0,
            nested_entries: &[],
        };
        let text = collect_text(&render_tool_call(&view));
        assert!(
            !text.contains("Dispatching"),
            "pre-dispatch line must not render (upstream 2.1.117 AgentTool/UI.tsx emits none): got {text:?}"
        );
    }

    #[test]
    fn relativize_path_strips_cwd_prefix_when_inside() {
        let cwd = std::env::current_dir().expect("cwd");
        let inside = cwd.join("child/file.md");
        let rel = relativize_path(inside.to_str().unwrap());
        assert_eq!(rel, "child/file.md");
    }

    #[test]
    fn relativize_path_leaves_unrelated_absolute_paths_alone() {
        let outside = "/etc/hosts";
        assert_eq!(relativize_path(outside), "/etc/hosts");
    }

    #[test]
    fn relativize_path_leaves_tilde_paths_alone() {
        assert_eq!(relativize_path("~/x.md"), "~/x.md");
    }

    #[test]
    fn write_preview_mirrors_upstream_plural_bug() {
        let args = serde_json::json!({});
        let v = serde_json::json!({"file_path":"stub.md","lines":1,"created":false});
        let s = expect_preview(payload_from_result("Write", &v, false, &serde_json::Value::Null).unwrap());
        let _ = args;
        assert!(
            s.contains("Wrote 1 lines"),
            "must mirror upstream FileWriteTool/UI.tsx:79 plural bug: got {s:?}"
        );
    }
}
