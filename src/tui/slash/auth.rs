

use super::super::state::ConversationState;
use super::SlashOutcome;
use crate::config::providers::{ProviderId, PROVIDER_ORDER};

pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "login" => handle_login(args, state),
        "logout" => handle_logout(args, state),
        other => {
            state.push_system_note(format!("unhandled auth slash: /{other}"));
            SlashOutcome::Handled
        }
    }
}

fn handle_login(args: &str, state: &mut ConversationState) -> SlashOutcome {
    let trimmed = args.trim();
    if trimmed.is_empty() {
        state.pending_login_provider = Some(state.provider_id);
        return SlashOutcome::Handled;
    }
    match ProviderId::from_slug(&trimmed.to_ascii_lowercase()) {
        Some(p) => {
            state.pending_login_provider = Some(p);
            SlashOutcome::Handled
        }
        None => {
            let known: Vec<&str> = PROVIDER_ORDER.iter().map(|p| p.slug()).collect();
            state.push_system_note(format!(
                "unknown provider `{trimmed}` — known: {}",
                known.join(", ")
            ));
            SlashOutcome::Handled
        }
    }
}

fn handle_logout(args: &str, state: &mut ConversationState) -> SlashOutcome {
    let trimmed = args.trim();
    if trimmed.is_empty() {
        let authed = crate::state::broker::authenticated_providers(&state.persistence.settings);
        if authed.is_empty() {
            state.push_system_note("no providers currently logged in");
        } else {
            let lines: Vec<String> = authed
                .iter()
                .enumerate()
                .map(|(i, p)| format!("  {}. /logout {} ({})", i + 1, p.slug(), p.label()))
                .collect();
            state.push_system_note(format!(
                "pass a provider slug — currently logged in:\n{}\n  {}. /logout all",
                lines.join("\n"),
                authed.len() + 1,
            ));
        }
        return SlashOutcome::Handled;
    }
    if trimmed.eq_ignore_ascii_case("all") {
        let authed = crate::state::broker::authenticated_providers(&state.persistence.settings);
        if authed.is_empty() {
            state.push_system_note("no providers currently logged in");
            return SlashOutcome::Handled;
        }
        for p in &authed {
            if let Err(e) = crate::state::broker::logout_provider(state, *p) {
                state.push_system_note(format!("logout {} failed: {e}", p.slug()));
            }
        }
        state.set_feedback(format!(
            "logged out · {}",
            authed.iter().map(|p| p.slug()).collect::<Vec<_>>().join(", ")
        ));
        return SlashOutcome::Handled;
    }
    match ProviderId::from_slug(&trimmed.to_ascii_lowercase()) {
        Some(p) => {
            state.pending_logout_provider = Some(p);
            SlashOutcome::Handled
        }
        None => {
            let known: Vec<&str> = PROVIDER_ORDER.iter().map(|p| p.slug()).collect();
            state.push_system_note(format!(
                "unknown provider `{trimmed}` — known: {}, or `all`",
                known.join(", ")
            ));
            SlashOutcome::Handled
        }
    }
}
