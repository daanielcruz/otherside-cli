

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
        lines.push(format!(
            "  {label:<8}  /{}",
            slashes.join(" /")
        ));
    }

    let panel_names: Vec<&str> = CATALOG
        .iter()
        .filter(|e| matches!(e.kind, SlashKind::Panel(_)))
        .map(|e| e.name)
        .collect();
    if !panel_names.is_empty() {
        lines.push(format!("  panel     /{}", panel_names.join(" /")));
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
