use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::Frame;

use super::state::{Mode, TaskRow, TasksPanelState};
use crate::tasks::{TaskKind, TaskState};
use crate::tui::panel_frame::{body_row, PanelFrame};
use crate::tui::render::theme;

/// Indent for section headers / non-selectable body rows. PanelFrame
/// body rows from `body_row` already carry a 2-col chevron prefix.
const BODY_INDENT: &str = "  ";
/// Sub-indent (4 cols) for activity rows under a section header.
const BODY_SUB_INDENT: &str = "    ";

pub fn draw_panel(f: &mut Frame<'_>, area: Rect, state: &TasksPanelState) {
    match state.mode {
        Mode::List => draw_list(f, area, state),
        Mode::Detail(_) => draw_detail(f, area, state),
    }
}

fn draw_list(f: &mut Frame<'_>, area: Rect, state: &TasksPanelState) {
    let body = list_body(state);
    let footer_hints: &[(&str, &str)] = &[
        ("\u{2191}/\u{2193}", "to select"),
        ("Enter", "to view"),
        ("\u{2190}/Esc", "to close"),
    ];
    let panel = PanelFrame {
        title: Some("Background tasks"),
        tabs: None,
        active_tab: 0,
        tabs_focused: false,
        search: None,
        body,
        footer_hints,
        pagination_hint: None,
    };
    panel.render(f, area);
}

fn draw_detail(f: &mut Frame<'_>, area: Rect, state: &TasksPanelState) {
    // Panel title (breadcrumb) + body + footer hints are constructed
    // eagerly so their backing Strings outlive the `render` call.
    let row = match state.focused_row() {
        Some(r) => r,
        None => {
            // Degenerate: no focused row; degrade to empty frame.
            let panel = PanelFrame {
                title: None,
                tabs: None,
                active_tab: 0,
                tabs_focused: false,
                search: None,
                body: vec![Line::from(vec![
                    Span::raw(BODY_INDENT),
                    Span::styled(
                        "(no task in focus)",
                        Style::default().fg(theme::MUTED),
                    ),
                ])],
                footer_hints: &[],
                pagination_hint: None,
            };
            panel.render(f, area);
            return;
        }
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
    let title = format!("{lead} \u{203A} {title_tail}");

    let body = detail_body_lines(row);

    // Footer byline owns the static labels. Because PanelFrame takes
    // `&[(&str, &str)]`, build a `Vec<(&str, &str)>` whose str slices
    // reference long-lived static strings.
    let mut hints: Vec<(&str, &str)> = Vec::with_capacity(3);
    if state.came_from_list {
        hints.push(("\u{2190}", "go back"));
    }
    hints.push(("Esc/Enter/Space", "close"));
    if matches!(row.state, TaskState::Running) {
        hints.push(("x", "stop"));
    }

    let panel = PanelFrame {
        title: Some(&title),
        tabs: None,
        active_tab: 0,
        tabs_focused: false,
        search: None,
        body,
        footer_hints: &hints,
        pagination_hint: None,
    };
    panel.render(f, area);
}

fn list_body(state: &TasksPanelState) -> Vec<Line<'static>> {
    let mut lines = Vec::with_capacity(state.rows.len() + 2);

    if state.rows.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "No tasks currently running",
                Style::default().fg(theme::MUTED),
            ),
        ]));
        return lines;
    }

    for (i, row) in state.rows.iter().enumerate() {
        let selected = i == state.cursor;
        lines.push(body_row(format_list_row(row), false, selected));
    }

    lines
}

fn detail_body_lines(row: &TaskRow) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(20);

    // Subtitle: `[status-icon status ·] {elapsed} [· {tokens} tokens] [· N tool(s)]`.
    // Whole row dim; status-icon prefix (if any) in status color.
    let tool_count = row.output.len();
    let mut subtitle_spans: Vec<Span<'static>> = Vec::with_capacity(6);
    subtitle_spans.push(Span::raw(BODY_INDENT));
    if !matches!(row.state, TaskState::Running) {
        if let Some((icon, label, color)) = status_icon_label_color(row.state) {
            subtitle_spans.push(Span::styled(
                format!("{icon} "),
                Style::default().fg(color),
            ));
            subtitle_spans.push(Span::styled(
                format!("{label} \u{00B7} "),
                Style::default().fg(color),
            ));
        }
    }
    let dim = Style::default()
        .fg(theme::MUTED)
        .add_modifier(Modifier::DIM);
    subtitle_spans.push(Span::styled(format_elapsed(row.runtime_secs), dim));
    if row.tokens > 0 {
        subtitle_spans.push(Span::styled(
            format!(
                " \u{00B7} {} tokens",
                crate::tui::tool_render::format_number_compact(row.tokens),
            ),
            dim,
        ));
    }
    if tool_count > 0 {
        subtitle_spans.push(Span::styled(
            format!(
                " \u{00B7} {} {}",
                tool_count,
                if tool_count == 1 { "tool" } else { "tools" },
            ),
            dim,
        ));
    }
    lines.push(Line::from(subtitle_spans));
    lines.push(Line::from(""));

    // Progress section (recent output lines). Prefix the LAST row with
    // `› ` and the earlier rows with `  ` — upstream pattern.
    if !row.output.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "Progress".to_string(),
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            ),
        ]));
        let n = row.output.len();
        let start = n.saturating_sub(5);
        for (i, line) in row.output.iter().enumerate().skip(start) {
            let is_last = i + 1 == n;
            let marker = if is_last { "\u{203A} " } else { "  " };
            // Upstream AsyncAgentDetailDialog.tsx:170 —
            // `dimColor={i < agent.progress.recentActivities.length - 1}`.
            let mut row_style = Style::default().fg(theme::TEXT);
            if !is_last {
                row_style = row_style.add_modifier(Modifier::DIM);
            }
            lines.push(Line::from(vec![
                Span::raw(BODY_SUB_INDENT),
                Span::styled(
                    format!("{marker}{}", truncate(line, 120)),
                    row_style,
                ),
            ]));
        }
        lines.push(Line::from(""));
    }

    // Prompt/Plan section.
    if !row.prompt.is_empty() {
        if let Some(plan) = extract_plan_tag(&row.prompt) {
            lines.push(Line::from(vec![
                Span::raw(BODY_INDENT),
                Span::styled(
                    "Plan".to_string(),
                    Style::default()
                        .fg(theme::TEXT)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            for body_line in plan.lines() {
                lines.push(Line::from(vec![
                    Span::raw(BODY_SUB_INDENT),
                    Span::styled(
                        body_line.to_string(),
                        Style::default().fg(theme::TEXT),
                    ),
                ]));
            }
            lines.push(Line::from(""));
        } else {
            lines.push(Line::from(vec![
                Span::raw(BODY_INDENT),
                Span::styled(
                    "Prompt".to_string(),
                    Style::default()
                        .fg(theme::TEXT)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            let preview = if row.prompt.chars().count() > 300 {
                let head: String = row.prompt.chars().take(297).collect();
                format!("{head}\u{2026}")
            } else {
                row.prompt.clone()
            };
            lines.push(Line::from(vec![
                Span::raw(BODY_SUB_INDENT),
                Span::styled(preview, Style::default().fg(theme::MUTED)),
            ]));
            lines.push(Line::from(""));
        }
    }

    lines
}

/// Human-readable elapsed time — mirrors upstream
/// `useElapsedTime` / `formatDuration` output (e.g. `"1m 44s"`,
/// `"45s"`, `"1h 2m 3s"`).
fn format_elapsed(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h {m}m {s}s")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

/// Status icon + label + color for non-running terminal states.
fn status_icon_label_color(
    st: TaskState,
) -> Option<(&'static str, &'static str, ratatui::style::Color)> {
    match st {
        TaskState::Completed => {
            Some(("\u{2713}", "Completed", theme::SUCCESS))
        }
        TaskState::Failed => Some(("\u{2717}", "Failed", theme::ERROR)),
        TaskState::Stopped => Some(("\u{25A0}", "Stopped", theme::MUTED)),
        TaskState::Running
        | TaskState::Backgrounded
        | TaskState::Pending => None,
    }
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
    segments.join(" \u{00B7} ")
}

/// Extract the first `<plan>…</plan>` body from `s`.
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
    format!("{head}\u{2026}")
}

/// Test-only helper — renders the detail body prose (subtitle, progress,
/// prompt/plan) for a given row. The breadcrumb title and footer byline
/// now live on PanelFrame, so tests that assert those must render the
/// full panel via `draw_panel`. This helper preserves the pre-migration
/// test surface that asserted on the inner body only.
#[cfg(test)]
fn detail_body(state: &TasksPanelState) -> Vec<Line<'static>> {
    match state.focused_row() {
        Some(r) => detail_body_lines(r),
        None => vec![Line::from(vec![
            Span::raw(BODY_INDENT),
            Span::styled(
                "(no task in focus)",
                Style::default().fg(theme::MUTED),
            ),
        ])],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{TaskId, TaskRecord as TR, TaskStore};
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use ratatui::style::Color;
    use ratatui::Terminal;

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

    fn render_panel(state: &TasksPanelState, width: u16, height: u16) -> Buffer {
        let backend = TestBackend::new(width, height);
        let mut term = Terminal::new(backend).expect("terminal");
        term.draw(|f| {
            let area = Rect::new(0, 0, width, height);
            draw_panel(f, area, state);
        })
        .unwrap();
        term.backend().buffer().clone()
    }

    fn buffer_row(buf: &Buffer, y: u16) -> String {
        let mut s = String::new();
        for x in 0..buf.area.width {
            s.push_str(buf[(x, y)].symbol());
        }
        s
    }

    #[test]
    fn empty_list_renders_notice() {
        let s = TaskStore::new();
        let st = TasksPanelState::new(&s);
        let text = collect_text(&list_body(&st));
        assert!(text.contains("No tasks currently running"));
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
        // Insert a second task so state starts in Mode::List (not auto-skipped).
        let mut r2 = TR::new_agent(
            TaskId::generate(),
            "verification".into(),
            "verify".into(),
        );
        r2.subagent_type = Some("verification".into());
        s.insert(r2);
        let st = TasksPanelState::new(&s);
        let text = collect_text(&list_body(&st));
        assert!(text.contains("\u{276F} "));
        assert!(
            text.contains("general-purpose \u{00B7} Sleep 200 echo ok"),
            "row leads with subagent_type · description: {text}"
        );
        assert!(text.contains("22.3k tokens") || text.contains("22300 tokens"));
    }

    #[test]
    fn breadcrumb_uses_u203a_not_ascii_or_guillemet() {
        // Pin the separator byte. U+203A (›) is mandated by
        // AsyncAgentDetailDialog.tsx:106 (`{type} ›{" "}{desc}`). The
        // breadcrumb now lives on PanelFrame.title — render the full
        // panel and scan the title row.
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
        let buf = render_panel(&st, 80, 20);
        // Title row at y=2 (y=0 rule, y=1 padding).
        let title_row = buffer_row(&buf, 2);
        assert!(
            title_row.contains("Plan \u{203A} State broker analysis"),
            "breadcrumb must render U+203A between type and description: {title_row:?}"
        );
        assert!(
            !title_row.contains("Plan \u{00BB} "),
            "must NOT use U+00BB (»): {title_row:?}"
        );
        assert!(
            !title_row.contains("Plan > "),
            "must NOT use ASCII '>': {title_row:?}"
        );
        assert!(
            !title_row.contains("Plan / "),
            "must NOT use '/': {title_row:?}"
        );
    }

    #[test]
    fn prompt_truncates_at_297_plus_ellipsis_when_over_300() {
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
        // Render the full panel so the PanelFrame-owned title + footer
        // bylines are in the buffer. Body sections (Progress, Prompt)
        // stay in `detail_body_lines` which we scan via the renders too.
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
        let buf = render_panel(&st, 100, 24);
        let mut all = String::new();
        for y in 0..24 {
            all.push_str(&buffer_row(&buf, y));
            all.push('\n');
        }
        assert!(all.contains("general-purpose \u{203A} Sleep 400 echo ok"));
        assert!(all.contains("22.1k tokens"));
        assert!(all.contains("Progress"));
        assert!(all.contains("\u{203A} Bash(bash -c 'sleep 400; echo ok')"));
        assert!(all.contains("Prompt"));
        assert!(all.contains("Run exactly"));
        // Single-task auto-skip → came_from_list=false → no `← go back`;
        // Running → `x stop` visible.
        assert!(
            all.contains("close"),
            "footer must render close hint: {all}",
        );
        assert!(
            all.contains(" stop"),
            "running-state footer must render stop hint: {all}",
        );
        assert!(
            !all.contains("go back"),
            "auto-skip must not render `go back`: {all}"
        );
    }

    #[test]
    fn progress_rows_dim_all_but_last() {
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "probe".into(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.push_output("Read(a.rs)".into());
        r.push_output("Read(b.rs)".into());
        r.push_output("Read(c.rs)".into());
        s.insert(r);
        let st = TasksPanelState::new(&s);
        let lines = detail_body(&st);

        let activity_rows: Vec<&Line<'_>> = lines
            .iter()
            .filter(|l| {
                l.spans
                    .iter()
                    .any(|s| s.content.contains("Read("))
            })
            .collect();
        assert_eq!(
            activity_rows.len(),
            3,
            "expected 3 activity rows, got {}: {:#?}",
            activity_rows.len(),
            activity_rows,
        );

        let dim_of = |line: &Line<'_>| -> bool {
            line.spans
                .iter()
                .find(|s| s.content.contains("Read("))
                .map(|s| s.style.add_modifier.contains(Modifier::DIM))
                .unwrap_or(false)
        };
        assert!(dim_of(activity_rows[0]), "row 0 must be dim");
        assert!(dim_of(activity_rows[1]), "row 1 must be dim");
        assert!(
            !dim_of(activity_rows[2]),
            "last (current) row must NOT be dim",
        );
    }

    #[test]
    fn subtitle_elapsed_renders_human_format() {
        assert_eq!(format_elapsed(0), "0s");
        assert_eq!(format_elapsed(45), "45s");
        assert_eq!(format_elapsed(104), "1m 44s");
        assert_eq!(format_elapsed(60), "1m 0s");
        assert_eq!(format_elapsed(3600), "1h 0m 0s");
        assert_eq!(format_elapsed(3661), "1h 1m 1s");
    }

    #[test]
    fn subtitle_hides_zero_counters() {
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "p".into(),
        );
        r.subagent_type = Some("general-purpose".into());
        r.description = Some("zero-counter probe".into());
        r.tokens = 0;
        s.insert(r);
        let st = TasksPanelState::new(&s);
        let text = collect_text(&detail_body(&st));
        assert!(
            !text.contains("0 tokens"),
            "zero tokens must NOT render: {text}",
        );
        assert!(
            !text.contains(" tools") && !text.contains(" tool "),
            "zero tool count must NOT render: {text}",
        );
    }

    #[test]
    fn subtitle_shows_status_icon_when_not_running() {
        fn mk_state(state: TaskState) -> TasksPanelState {
            let row = TaskRow {
                name: "general-purpose".into(),
                description: Some("status probe".into()),
                subagent_type: Some("general-purpose".into()),
                kind: TaskKind::Agent,
                state,
                runtime_secs: 12,
                tokens: 0,
                output: Vec::new(),
                prompt: "p".into(),
                tool_use_id: None,
            };
            TasksPanelState {
                mode: Mode::Detail(0),
                cursor: 0,
                rows: vec![row],
                came_from_list: false,
            }
        }

        let text = collect_text(&detail_body(&mk_state(TaskState::Completed)));
        assert!(
            text.contains("\u{2713} Completed \u{00B7} "),
            "completed status must prefix subtitle with ✓ + label: {text}",
        );

        let text2 = collect_text(&detail_body(&mk_state(TaskState::Failed)));
        assert!(
            text2.contains("\u{2717} Failed \u{00B7} "),
            "failed status must prefix subtitle with ✗ + label: {text2}",
        );

        let text3 = collect_text(&detail_body(&mk_state(TaskState::Stopped)));
        assert!(
            text3.contains("\u{25A0} Stopped \u{00B7} "),
            "stopped status must prefix subtitle with ■ + label: {text3}",
        );

        let text4 = collect_text(&detail_body(&mk_state(TaskState::Running)));
        assert!(
            !text4.contains("\u{2713}")
                && !text4.contains("\u{2717}")
                && !text4.contains("\u{25A0}"),
            "running status must NOT render a status-icon prefix: {text4}",
        );
    }

    #[test]
    fn footer_byline_gates_shortcuts() {
        // Running + came_from_list=true → all 3 shortcuts.
        // PanelFrame owns the footer byline now — render full panel and
        // scan the last row for hint labels.
        let s = TaskStore::new();
        let mut r1 = TR::new_agent(
            TaskId::generate(),
            "a".into(),
            "p".into(),
        );
        r1.subagent_type = Some("a".into());
        s.insert(r1);
        let mut r2 = TR::new_agent(
            TaskId::generate(),
            "b".into(),
            "p".into(),
        );
        r2.subagent_type = Some("b".into());
        s.insert(r2);
        let mut st = TasksPanelState::new(&s);
        st.enter_detail();
        let buf = render_panel(&st, 80, 16);
        let mut all = String::new();
        for y in 0..16 {
            all.push_str(&buffer_row(&buf, y));
            all.push('\n');
        }
        assert!(
            all.contains("go back"),
            "drilled-in detail must show `go back` hint: {all}",
        );
        assert!(all.contains("close"));
        assert!(all.contains(" stop"));

        // Completed + came_from_list=false → only close hint.
        let st2 = TasksPanelState {
            mode: Mode::Detail(0),
            cursor: 0,
            rows: vec![TaskRow {
                name: "solo".into(),
                description: Some("solo".into()),
                subagent_type: Some("solo".into()),
                kind: TaskKind::Agent,
                state: TaskState::Completed,
                runtime_secs: 5,
                tokens: 0,
                output: Vec::new(),
                prompt: "p".into(),
                tool_use_id: None,
            }],
            came_from_list: false,
        };
        let buf2 = render_panel(&st2, 80, 16);
        let mut all2 = String::new();
        for y in 0..16 {
            all2.push_str(&buffer_row(&buf2, y));
            all2.push('\n');
        }
        assert!(all2.contains("close"));
        assert!(
            !all2.contains("go back"),
            "auto-skip must NOT render `go back`: {all2}",
        );
        assert!(
            !all2.contains(" stop"),
            "non-running must NOT render `stop`: {all2}",
        );
    }

    #[test]
    fn tasks_panel_uses_panel_frame_chrome() {
        // List view with two tasks — PanelFrame chrome must paint
        // y=0 top rule (theme::PRIMARY), y=1 blank padding, and the
        // selected body row gets a theme::SUCCESS chevron.
        let s = TaskStore::new();
        let mut r1 = TR::new_agent(
            TaskId::generate(),
            "alpha".into(),
            "p".into(),
        );
        r1.subagent_type = Some("alpha".into());
        r1.description = Some("first".into());
        s.insert(r1);
        let mut r2 = TR::new_agent(
            TaskId::generate(),
            "beta".into(),
            "p".into(),
        );
        r2.subagent_type = Some("beta".into());
        r2.description = Some("second".into());
        s.insert(r2);
        let st = TasksPanelState::new(&s);
        assert!(matches!(st.mode, Mode::List));

        let buf = render_panel(&st, 80, 12);

        let rule_cell = buf[(3, 0)].clone();
        assert_eq!(
            rule_cell.symbol(),
            "\u{2500}",
            "y=0 must be top-rule glyph: {rule_cell:?}"
        );
        assert_eq!(
            rule_cell.fg,
            Color::Rgb(0x3E, 0xA0, 0xC3),
            "top rule fg must be theme::PRIMARY: {rule_cell:?}"
        );

        let row1 = buffer_row(&buf, 1);
        assert_eq!(
            row1.trim(),
            "",
            "y=1 must be blank padding row, got {row1:?}"
        );

        let mut found = false;
        for y in 2..12u16 {
            let cell = buf[(0, y)].clone();
            if cell.symbol() == "\u{276F}" {
                assert_eq!(
                    cell.fg,
                    Color::Rgb(78, 186, 101),
                    "selected body-row chevron must be theme::SUCCESS at y={y}: {cell:?}"
                );
                found = true;
                break;
            }
        }
        assert!(
            found,
            "expected a selected body-row chevron somewhere in the list body"
        );
    }

    #[test]
    fn tasks_panel_agent_detail_uses_panel_frame_title() {
        // Detail view must expose the breadcrumb as PanelFrame.title,
        // which lands at y=2 (y=0 rule, y=1 padding).
        let s = TaskStore::new();
        let mut r = TR::new_agent(
            TaskId::generate(),
            "general-purpose".into(),
            "probe".into(),
        );
        r.subagent_type = Some("Plan".into());
        r.description = Some("broker audit".into());
        s.insert(r);
        let st = TasksPanelState::new(&s);
        assert!(matches!(st.mode, Mode::Detail(0)));

        let buf = render_panel(&st, 80, 16);
        let title_row = buffer_row(&buf, 2);
        assert!(
            title_row.contains("Plan \u{203A} broker audit"),
            "breadcrumb title must render on row 2 (post-padding): {title_row:?}"
        );
        // Title must be bold per PanelFrame::draw_title.
        let title_x: u16 = title_row
            .find('P')
            .map(|i| i as u16)
            .expect("find 'P' of 'Plan' on title row");
        let title_cell = buf[(title_x, 2)].clone();
        assert!(
            title_cell.modifier.contains(Modifier::BOLD),
            "title cell must be bold: {title_cell:?}"
        );
    }
}
