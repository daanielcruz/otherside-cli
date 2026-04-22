

use super::super::menu;
use super::super::state::ConversationState;
use super::PanelKind;
use super::SlashOutcome;

pub fn handle(kind: PanelKind, state: &mut ConversationState) -> SlashOutcome {

    state.input.clear();
    state.autocomplete = None;
    let overlay = match kind {
        PanelKind::Effort => menu::OverlayMenu::new_effort(state.session.effort_label),
        PanelKind::Permissions => menu::OverlayMenu::new_permissions(state.session.permission_mode),
        PanelKind::Model => {

            let effort = state
                .session
                .effort_label
                .unwrap_or_else(|| crate::models::catalog::default_effort_for(&state.session.model));
            menu::OverlayMenu::new_model_with_effort(&state.session.model, Some(effort))
        }
        PanelKind::Help => menu::OverlayMenu::new_info(
            PanelKind::Help,
            "Slash commands".into(),
            help_hints(),
        ),

        PanelKind::Settings(tab) => menu::OverlayMenu::new_settings(tab, state),
        PanelKind::Skills => menu::OverlayMenu::new_info(
            PanelKind::Skills,
            "Skills".into(),
            vec![
                "Skills are bundled under otherside-cli/skills/.".into(),
                "Use the Skill tool to load one mid-turn.".into(),
            ],
        ),
        PanelKind::Agents => menu::OverlayMenu::new_info(
            PanelKind::Agents,
            "Subagents".into(),
            vec![
                "Subagents live at otherside-cli/agents/.".into(),
                "Invoke via the Agent tool with `subagent_type`.".into(),
            ],
        ),
        PanelKind::Mcp => menu::OverlayMenu::new_info(
            PanelKind::Mcp,
            "MCP servers".into(),
            vec![
                "MCP JSON-RPC client lands in the Phase 3 tier.".into(),
                "No servers active this session.".into(),
            ],
        ),
        PanelKind::Tasks => {

            menu::OverlayMenu::new_info(
                PanelKind::Tasks,
                "Background tasks".into(),
                tasks_hints(state),
            )
        }
        PanelKind::Hooks => menu::OverlayMenu::new_info(
            PanelKind::Hooks,
            "Hooks".into(),
            hooks_hints(state),
        ),
        PanelKind::Diff => menu::OverlayMenu::new_info(
            PanelKind::Diff,
            "Diff".into(),
            vec!["Diff picker lands with session history (spec 008).".into()],
        ),
        PanelKind::Resume => menu::OverlayMenu::new_info(
            PanelKind::Resume,
            "Resume".into(),
            vec!["Session resume lands with persistence (spec 008).".into()],
        ),
        PanelKind::Rewind => menu::OverlayMenu::new_info(
            PanelKind::Rewind,
            "Rewind".into(),
            vec!["/rewind: session-history reset lands in a follow-up change.".into()],
        ),
    };
    state.active_menu = Some(overlay);
    SlashOutcome::Handled
}

fn push_wrapped_group(lines: &mut Vec<String>, label: &str, slashes: &[&str]) {
    const WIDTH_BUDGET: usize = 78;
    const HEADER_WIDTH: usize = 12;

    let mut row: Vec<&str> = Vec::new();
    let mut row_len = HEADER_WIDTH;
    let mut first_row = true;
    for name in slashes {
        let cost = name.chars().count() + 2;
        if !row.is_empty() && row_len + cost > WIDTH_BUDGET {
            let prefix = if first_row { label } else { "" };
            lines.push(format!("  {prefix:<8}  /{}", row.join(" /")));
            first_row = false;
            row.clear();
            row_len = HEADER_WIDTH;
        }
        row.push(name);
        row_len += cost;
    }
    if !row.is_empty() {
        let prefix = if first_row { label } else { "" };
        lines.push(format!("  {prefix:<8}  /{}", row.join(" /")));
    }
}

#[cfg(test)]
pub(crate) fn help_hints_for_test() -> Vec<String> {
    help_hints()
}

fn help_hints() -> Vec<String> {
    use super::catalog::{CATALOG, SlashKind};
    let mut lines = vec![
        format!("otherside cli v{}", env!("CARGO_PKG_VERSION")),
        String::new(),
        "Shortcuts".into(),
        "  Enter          submit turn               Shift+Enter   newline".into(),
        "  Tab            autocomplete slash        Shift+Tab     cycle permission mode".into(),
        "  ↑ / ↓          input history             Shift+↑/↓     scroll log one line".into(),
        "  PgUp / PgDn    scroll log ± 10 lines     Ctrl+Home/End jump top / bottom".into(),
        "  Esc            cancel overlay / stream   Ctrl+U        kill input line".into(),
        "  Ctrl+C         arm exit (2× to quit)     Ctrl+D        exit when input empty".into(),
        "  !              bash passthrough line".into(),
        String::new(),
        "Slash commands".into(),
    ];

    for kind in [
        SlashKind::Instant,
        SlashKind::Toggle,
        SlashKind::Skill,
        SlashKind::Anchor,
        SlashKind::Auth,
        SlashKind::Panel(super::PanelKind::Help),
    ] {
        let slashes: Vec<&str> = CATALOG
            .iter()
            .filter(|e| matches!(e.kind, ref k if std::mem::discriminant(k) == std::mem::discriminant(&kind)))
            .map(|e| e.name)
            .collect();
        if slashes.is_empty() {
            continue;
        }
        let label = match kind {
            SlashKind::Instant => "instant",
            SlashKind::Toggle => "toggle",
            SlashKind::Skill => "skill",
            SlashKind::Anchor => "anchor",
            SlashKind::Panel(_) => "panel",
            SlashKind::Auth => "auth",
        };
        push_wrapped_group(&mut lines, label, &slashes);
    }
    lines.push(String::new());
    lines.push("Type `/` to filter. Type `/<prefix>` to narrow.".into());
    lines
}

fn hooks_hints(st: &ConversationState) -> Vec<String> {
    let Some(h) = st.persistence.settings.hooks.as_ref() else {
        return vec!["no hooks configured".into()];
    };
    vec![
        format!("pre_tool_use: {}", h.pre_tool_use.len()),
        format!("post_tool_use: {}", h.post_tool_use.len()),
        format!("user_prompt_submit: {}", h.user_prompt_submit.len()),
        format!("stop: {}", h.stop.len()),
    ]
}

fn tasks_hints(st: &ConversationState) -> Vec<String> {
    if crate::tasks::is_disabled() {
        return vec![
            "Background tasks disabled via OTHERSIDE_DISABLE_BACKGROUND_TASKS".into(),
        ];
    }
    let active = st.tasks.list_active();
    if active.is_empty() {
        return vec!["No tasks currently running".into()];
    }
    active
        .into_iter()
        .map(|r| {
            format!(
                "{} · {} · running for {}s",
                r.name,
                r.id.as_str(),
                r.runtime_secs(),
            )
        })
        .collect()
}

#[cfg(test)]
mod help_hints_tests {
    use super::*;

    #[test]
    fn help_hints_lists_every_catalog_row_including_tail_panels() {
        let hints = help_hints_for_test();
        let joined = hints.join("\n");

        for name in ["help", "usage", "mcp", "tasks", "bashes"] {
            assert!(
                joined.contains(&format!("/{name}")),
                "/help panel must render /{name} — parity e2e 2026-04-21 flagged the last 4 panel entries as missing when the panel row wraps past overlay height"
            );
        }
    }

    #[test]
    fn help_hints_panel_rows_fit_under_80_columns() {
        let hints = help_hints_for_test();
        for (i, line) in hints.iter().enumerate() {
            assert!(
                line.chars().count() <= 80,
                "line {i} exceeds 80 cols ({}) — overlay clips past here:\n{}",
                line.chars().count(),
                line
            );
        }
    }
}
