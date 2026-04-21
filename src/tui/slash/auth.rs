

use super::super::state::ConversationState;
use super::SlashOutcome;

pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    let provider_hint = if args.is_empty() {
        "<provider>".to_string()
    } else {
        args.to_string()
    };
    match name.to_ascii_lowercase().as_str() {
        "login" => {
            state.push_system_note(format!(
                "/login needs stdin interaction — exit the TUI and run:\n    otherside login --provider {provider_hint}"
            ));
            SlashOutcome::Handled
        }
        "logout" => {
            state.push_system_note(format!(
                "to log out: exit the TUI and run:\n    otherside logout --provider {provider_hint}"
            ));
            SlashOutcome::Handled
        }
        other => {
            state.push_system_note(format!("unhandled auth slash: /{other}"));
            SlashOutcome::Handled
        }
    }
}
