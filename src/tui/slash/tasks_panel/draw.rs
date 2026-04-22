use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::state::{Mode, TaskRow, TasksPanelState};
use crate::tasks::{TaskKind, TaskState};
use crate::tui::render::theme;

const BODY_HEADER_INDENT: &str = "  ";
const BODY_INDENT: &str = "    ";
const LIST_FOOTER: &str =
    "↑↓ navigate · Enter/→ select · Esc close";
const DETAIL_FOOTER: &str =
    "← to go back · Esc/Enter/Space to close · x to stop";

pub fn draw_panel(f: &mut Frame<'_>, area: Rect, state: &TasksPanelState) {
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(20);
    match state.mode {
        Mode::List => lines.extend(list_body(state)),
        Mode::Detail(_) => lines.extend(detail_body(state)),
    }
    let para = Paragraph::new(lines);
    f.render_widget(para, area);
}

fn list_body(state: &TasksPanelState) -> Vec<Line<'static>> {
    let mut lines = Vec::with_capacity(state.rows.len() + 4);
    lines.push(Line::from(Span::styled(
        format!("{BODY_HEADER_INDENT}Background tasks"),
        Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));

    if state.rows.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(
                "No background tasks running.",
                Style::default().fg(theme::MUTED),
            ),
        ]));
    } else {
        for (i, row) in state.rows.iter().enumerate() {
            let selected = i == state.cursor;
            let prefix = if selected { "▶ " } else { "  " };
            let style = if selected {
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{BODY_HEADER_INDENT}{prefix}"),
                    style,
                ),
                Span::styled(format_list_row(row), style),
            ]));
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        format!("{BODY_HEADER_INDENT}{LIST_FOOTER}"),
        Style::default().fg(theme::MUTED),
    )));
    lines
}

fn detail_body(state: &TasksPanelState) -> Vec<Line<'static>> {
    let mut lines = Vec::with_capacity(20);
    let Some(row) = state.focused_row() else {
        lines.push(Line::from(Span::styled(
            format!("{BODY_HEADER_INDENT}(no task in focus)"),
            Style::default().fg(theme::MUTED),
        )));
        return lines;
    };

    // Title: `{subagent_type} › {description || 'Async agent'}` — mirrors
    // AsyncAgentDetailDialog.tsx:106.
    let lead = row
        .subagent_type
        .clone()
        .unwrap_or_else(|| row.name.clone());
    let title_tail = row
        .description
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| match row.kind {
            TaskKind::Agent => "Async agent".to_string(),
            TaskKind::Shell => "Shell".to_string(),
            TaskKind::Generic => "Task".to_string(),
        });
    lines.push(Line::from(vec![
        Span::raw(BODY_HEADER_INDENT),
        Span::styled(
            format!("{lead} › {title_tail}"),
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ),
    ]));

    // Subtitle: `{elapsed}s · {tokens} tokens · {N} tools` — dimColor.
    // Tool count is output.len() (best approximation of tool-use count
    // until runner streams per-tool events).
    let tool_count = row.output.len();
    let subtitle = format!(
        "{}s · {} tokens · {} tool{}",
        row.runtime_secs,
        crate::tui::tool_render::format_number_compact(row.tokens),
        tool_count,
        if tool_count == 1 { "" } else { "s" },
    );
    lines.push(Line::from(vec![
        Span::raw(BODY_HEADER_INDENT),
        Span::styled(subtitle, Style::default().fg(theme::MUTED)),
    ]));
    lines.push(Line::from(""));

    // Progress section (recent output lines). Prefix the LAST row with
    // `› ` and the earlier rows with `  ` — upstream pattern.
    if !row.output.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(
                "Progress".to_string(),
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            ),
        ]));
        let n = row.output.len();
        // Render up to the last 5 to keep the overlay bounded.
        let start = n.saturating_sub(5);
        for (i, line) in row.output.iter().enumerate().skip(start) {
            let marker = if i + 1 == n { "› " } else { "  " };
            lines.push(Line::from(vec![
                Span::raw(BODY_INDENT),
                Span::styled(
                    format!("{marker}{}", truncate(line, 120)),
                    Style::default().fg(theme::TEXT),
                ),
            ]));
        }
        lines.push(Line::from(""));
    }

    // Prompt/Plan section.
    //
    // Upstream (`AsyncAgentDetailDialog.tsx:92-98, 180`) extracts a
    // `<plan>…</plan>` tag from `agent.prompt` via `extractTag`; when
    // present it renders `<UserPlanMessage>` INSTEAD of the truncated
    // prompt block. We mirror the branch with a simple string-based
    // extractor (no regex crate available; nested `<plan>` tags are not
    // observed in practice).
    //
    // Plan heading text is "Plan" per our panel spec
    // (`docs/ui-panels/agent-detail.md`); upstream uses "Plan to
    // implement" — documented deviation.
    if !row.prompt.is_empty() {
        if let Some(plan) = extract_plan_tag(&row.prompt) {
            lines.push(Line::from(vec![
                Span::raw(BODY_HEADER_INDENT),
                Span::styled(
                    "Plan".to_string(),
                    Style::default()
                        .fg(theme::TEXT)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            for body_line in plan.lines() {
                lines.push(Line::from(vec![
                    Span::raw(BODY_INDENT),
                    Span::styled(
                        body_line.to_string(),
                        Style::default().fg(theme::TEXT),
                    ),
                ]));
            }
            lines.push(Line::from(""));
        } else {
            lines.push(Line::from(vec![
                Span::raw(BODY_HEADER_INDENT),
                Span::styled(
                    "Prompt".to_string(),
                    Style::default()
                        .fg(theme::TEXT)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            // Upstream: `prompt.length > 300 ? prompt.substring(0, 297) + '…' : prompt`.
            // Measured in UTF-16 code units upstream — we use char count
            // which matches for the ASCII-dominant prompts we observe and
            // is a closer semantic than raw byte length.
            let preview = if row.prompt.chars().count() > 300 {
                let head: String = row.prompt.chars().take(297).collect();
                format!("{head}\u{2026}")
            } else {
                row.prompt.clone()
            };
            lines.push(Line::from(vec![
                Span::raw(BODY_INDENT),
                Span::styled(preview, Style::default().fg(theme::MUTED)),
            ]));
            lines.push(Line::from(""));
        }
    }

    // Status line for finished tasks so `← back` is obvious.
    let status_note = match row.state {
        TaskState::Completed => Some("Status: completed"),
        TaskState::Failed => Some("Status: failed"),
        TaskState::Stopped => Some("Status: stopped"),
        TaskState::Running | TaskState::Backgrounded | TaskState::Pending => None,
    };
    if let Some(s) = status_note {
        lines.push(Line::from(vec![
            Span::raw(BODY_HEADER_INDENT),
            Span::styled(
                s.to_string(),
                Style::default().fg(theme::MUTED),
            ),
        ]));
        lines.push(Line::from(""));
    }

    lines.push(Line::from(Span::styled(
        format!("{BODY_HEADER_INDENT}{DETAIL_FOOTER}"),
        Style::default().fg(theme::MUTED),
    )));
    lines
}

fn format_list_row(row: &TaskRow) -> String {
    let mut segments = Vec::with_capacity(4);
    let lead = row
        .subagent_type
        .clone()
        .unwrap_or_else(|| row.name.clone());
    segments.push(lead);
    if let Some(desc) = &row.description {
        segments.push(desc.clone());
    } else if matches!(row.kind, TaskKind::Shell) && !row.prompt.is_empty() {
        segments.push(truncate(&row.prompt, 60));
    }
    segments.push(format!("{}s", row.runtime_secs));
    segments.push(format!(
        "{} tokens",
        crate::tui::tool_render::format_number_compact(row.tokens),
    ));
    segments.join(" · ")
}

/// Extract the first `<plan>…</plan>` body from `s`. Mirrors upstream
/// `extractTag(prompt, "plan")` (`utils/messages.ts:647`) for the common
/// non-nested case we observe in practice. Returns trimmed content or
/// `None` if no pair is found. Case-insensitive on the tag name to match
/// upstream's `gi` regex flags.
fn extract_plan_tag(s: &str) -> Option<String> {
    let lower = s.to_ascii_lowercase();
    let open_idx = lower.find("<plan>")?;
    let body_start = open_idx + "<plan>".len();
    let rel_close = lower[body_start..].find("</plan>")?;
    let body_end = body_start + rel_close;
    let body = &s[body_start..body_end];
    let trimmed = body.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn truncate(s: &str, cap: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= cap {
        return s.to_string();
    }
    let head: String = chars.into_iter().take(cap - 1).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{TaskId, TaskRecord as TR, TaskStore};

    fn collect_text(lines: &[Line<'_>]) -> String {
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
    fn empty_list_renders_notice_and_footer() {
        let s = TaskStore::new();
        let st = TasksPanelState::new(&s);
        let text = collect_text(&list_body(&st));
        assert!(text.contains("Background tasks"));
        assert!(text.contains("No background tasks running."));
        assert!(text.contains("Esc close"));
    }

    #[test]
    fn list_row_format_matches_upstream_shape() {
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "do stuff".into(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.description = Some("Sleep 200 echo ok".into());
        r.tokens = 22_300;
        s.insert(r);
        let mut st = TasksPanelState::new(&s);
        st.mode = Mode::List;
        let text = collect_text(&list_body(&st));
        assert!(text.contains("▶ "));
        assert!(
            text.contains("general-purpose · Sleep 200 echo ok"),
            "row leads with subagent_type · description: {text}"
        );
        assert!(text.contains("22.3k tokens") || text.contains("22300 tokens"));
    }

    #[test]
    fn breadcrumb_uses_u203a_not_ascii_or_guillemet() {
        // Pin the separator byte. U+203A (›) is mandated by
        // AsyncAgentDetailDialog.tsx:106 (`{type} ›{" "}{desc}`).
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "prompt body".into(),
        );
        r.subagent_type = Some("Plan".into());
        r.description = Some("State broker analysis".into());
        s.insert(r);
        let st = TasksPanelState::new(&s);
        let text = collect_text(&detail_body(&st));
        // Exact codepoint pin.
        assert!(
            text.contains("Plan \u{203A} State broker analysis"),
            "breadcrumb must render U+203A between type and description: {text:?}"
        );
        // Negative assertions — any of these would be a regression.
        assert!(
            !text.contains("Plan \u{00BB} "),
            "must NOT use U+00BB (»): {text:?}"
        );
        assert!(
            !text.contains("Plan > "),
            "must NOT use ASCII '>': {text:?}"
        );
        assert!(
            !text.contains("Plan / "),
            "must NOT use '/': {text:?}"
        );
    }

    #[test]
    fn prompt_truncates_at_297_plus_ellipsis_when_over_300() {
        // Upstream rule: length > 300 → substring(0, 297) + '…'.
        // 301 chars of 'a' must yield 297 'a's + '…', total 298 chars.
        let s = TaskStore::new();
        let long_prompt: String = "a".repeat(301);
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            long_prompt.clone(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.description = Some("truncation probe".into());
        s.insert(r);
        let st = TasksPanelState::new(&s);
        let text = collect_text(&detail_body(&st));

        // Find the rendered prompt body by scanning lines.
        let body_line = text
            .lines()
            .find(|l| l.trim_start().starts_with('a'))
            .expect("rendered prompt body line");
        let body = body_line.trim_start();
        assert!(
            body.ends_with('\u{2026}'),
            "truncated body must end with U+2026 (…): {body:?}"
        );
        let pre_ellipsis: String =
            body.chars().take_while(|c| *c != '\u{2026}').collect();
        assert_eq!(
            pre_ellipsis.chars().count(),
            297,
            "upstream trims to exactly 297 chars before …, got {}",
            pre_ellipsis.chars().count()
        );
    }

    #[test]
    fn prompt_at_or_under_300_chars_renders_in_full() {
        // Boundary: exactly 300 chars must NOT be truncated.
        let s = TaskStore::new();
        let exact_prompt: String = "b".repeat(300);
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            exact_prompt.clone(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.description = Some("boundary probe".into());
        s.insert(r);
        let st = TasksPanelState::new(&s);
        let text = collect_text(&detail_body(&st));
        assert!(
            text.contains(&exact_prompt),
            "prompt of exactly 300 chars must render in full (no truncation)"
        );
        assert!(
            !text.contains("bbb\u{2026}"),
            "prompt of exactly 300 chars must NOT end with …"
        );
    }

    #[test]
    fn plan_tag_replaces_prompt_section() {
        // Upstream: when <plan>…</plan> extracts non-empty content, render
        // the plan block INSTEAD of the Prompt block. We mirror the
        // branch.
        let s = TaskStore::new();
        let plan_prompt = "preamble\n<plan>\nStep 1: audit auth\nStep 2: land broker\n</plan>\ntrailer";
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            plan_prompt.to_string(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.description = Some("plan-tag probe".into());
        s.insert(r);
        let st = TasksPanelState::new(&s);
        let text = collect_text(&detail_body(&st));
        assert!(
            text.contains("Plan") && !text.contains("Prompt\n"),
            "plan branch must render 'Plan' heading and SUPPRESS 'Prompt' heading: {text:?}"
        );
        assert!(
            text.contains("Step 1: audit auth"),
            "plan body must include tag content: {text:?}"
        );
        assert!(
            text.contains("Step 2: land broker"),
            "plan body must include tag content: {text:?}"
        );
        // Preamble/trailer text outside <plan>…</plan> must NOT leak.
        assert!(
            !text.contains("preamble"),
            "plan branch must NOT render content outside the tag: {text:?}"
        );
        assert!(
            !text.contains("trailer"),
            "plan branch must NOT render content outside the tag: {text:?}"
        );
    }

    #[test]
    fn plan_tag_extractor_handles_missing_and_empty() {
        assert_eq!(extract_plan_tag("no tag here"), None);
        assert_eq!(extract_plan_tag("<plan></plan>"), None);
        assert_eq!(extract_plan_tag("<plan>   </plan>"), None);
        assert_eq!(
            extract_plan_tag("before <PLAN>hello</PLAN> after").as_deref(),
            Some("hello"),
            "case-insensitive like upstream `gi` regex flags"
        );
    }

    #[test]
    fn detail_carries_title_subtitle_prompt_footer() {
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "Run exactly: `sleep 400 && echo ok`".into(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.description = Some("Sleep 400 echo ok".into());
        r.tokens = 22_100;
        r.push_output("Bash(sleep 400 && echo ok)".into());
        r.push_output("Bash(bash -c 'sleep 400; echo ok')".into());
        s.insert(r);
        let st = TasksPanelState::new(&s);
        assert!(matches!(st.mode, Mode::Detail(0)));
        let text = collect_text(&detail_body(&st));
        assert!(text.contains("general-purpose › Sleep 400 echo ok"));
        assert!(text.contains("22.1k tokens"));
        assert!(text.contains("Progress"));
        assert!(text.contains("› Bash(bash -c 'sleep 400; echo ok')"));
        assert!(text.contains("Prompt"));
        assert!(text.contains("Run exactly"));
        assert!(text.contains(
            "← to go back · Esc/Enter/Space to close · x to stop"
        ));
    }
}
