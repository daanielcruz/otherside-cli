

use super::super::state::{ConversationState, DisplayOrigin};
use super::SlashOutcome;

pub fn handle(name: &str, args: &str, state: &mut ConversationState) -> SlashOutcome {
    match name.to_ascii_lowercase().as_str() {
        "clear" => {
            state.clear_conversation();

            state.push_anchor("clear", "", "(no content)", DisplayOrigin::Chrome);
            SlashOutcome::Handled
        }
        "exit" => SlashOutcome::ExitApp,
        "provider" => handle_provider(args, state),
        other => {
            state.push_system_note(format!("unhandled instant slash: /{other}"));
            SlashOutcome::Handled
        }
    }
}

fn handle_provider(args: &str, state: &mut ConversationState) -> SlashOutcome {
    use crate::config::providers::ProviderId;

    let trimmed = args.trim();
    if trimmed.is_empty() {
        let current = state.provider_id.slug();
        let available = crate::config::providers::PROVIDER_ORDER
            .iter()
            .map(|p| p.slug())
            .collect::<Vec<_>>()
            .join(" · ");
        state.push_anchor(
            "provider",
            "",
            format!("current: {current} — options: {available}"),
            DisplayOrigin::Chrome,
        );
        return SlashOutcome::Handled;
    }

    let slug_input = trimmed.split_whitespace().next().unwrap_or(trimmed);
    let Some(next) = ProviderId::from_slug(slug_input) else {
        state.push_anchor(
            "provider",
            args,
            format!(
                "unknown provider: {slug_input} (try: anthropic-oauth, codex-oauth, kimi, gemini-oauth, openai-custom)"
            ),
            DisplayOrigin::Chrome,
        );
        return SlashOutcome::Handled;
    };

    if next == state.provider_id {
        state.push_anchor(
            "provider",
            args,
            format!("already on {}", next.label()),
            DisplayOrigin::Chrome,
        );
        return SlashOutcome::Handled;
    }

    let previous_model = state.session.model.clone();
    let landed_model = state.switch_provider(next);

    let result_msg = if landed_model == previous_model {
        format!("Switched provider to {}", next.label())
    } else {
        format!(
            "Switched provider to {} — model now {}",
            next.label(),
            landed_model
        )
    };
    state.push_anchor("provider", args, result_msg, DisplayOrigin::Chrome);
    SlashOutcome::Handled
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::providers::ProviderId;

    #[test]
    fn clear_emits_anchor_after_wipe() {
        let mut st = ConversationState::default();
        st.push_system_note("pre-existing note");
        handle("clear", "", &mut st);
        let len = st.messages.len();
        assert_eq!(len, 2, "expected user-echo + anchor after clear");
        assert_eq!(st.messages[len - 2].content, "/clear");
        assert_eq!(st.messages[len - 1].content, "⎿  (no content)");
    }

    #[test]
    fn provider_switch_kimi_updates_state_and_settings_in_lockstep() {
        let mut st = ConversationState::default();
        st.provider_id = ProviderId::ClaudeCode;
        st.session.model = "claude-opus-4-7[1m]".into();

        handle("provider", "kimi", &mut st);

        assert_eq!(st.provider_id, ProviderId::Kimi);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("kimi")
        );
        assert_eq!(st.session.model, "kimi-for-coding");
    }

    #[test]
    fn provider_switch_same_slug_is_a_no_op_with_feedback() {
        let mut st = ConversationState::default();
        st.provider_id = ProviderId::Kimi;
        st.session.model = "kimi-for-coding".into();
        st.persistence.settings.default_provider = Some("kimi".into());

        handle("provider", "kimi", &mut st);

        assert_eq!(st.provider_id, ProviderId::Kimi);
        let last = st.messages.last().unwrap().content.clone();
        assert!(last.contains("already on Kimi"), "got {last:?}");
    }

    #[test]
    fn provider_switch_unknown_slug_leaves_state_untouched() {
        let mut st = ConversationState::default();
        st.provider_id = ProviderId::ClaudeCode;
        st.session.model = "claude-opus-4-7[1m]".into();
        st.persistence.settings.default_provider = Some("anthropic-oauth".into());

        handle("provider", "bogus-vendor", &mut st);

        assert_eq!(st.provider_id, ProviderId::ClaudeCode);
        assert_eq!(st.session.model, "claude-opus-4-7[1m]");
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("anthropic-oauth")
        );
        let last = st.messages.last().unwrap().content.clone();
        assert!(last.contains("unknown provider"), "got {last:?}");
    }

    #[test]
    fn provider_bare_invocation_surfaces_current_and_options() {
        let mut st = ConversationState::default();
        st.provider_id = ProviderId::Codex;
        handle("provider", "", &mut st);
        let last = st.messages.last().unwrap().content.clone();
        assert!(last.contains("current: codex-oauth"), "got {last:?}");
        assert!(last.contains("kimi"), "got {last:?}");
    }

    #[test]
    fn provider_switch_keeps_model_when_it_belongs_to_target() {
        let mut st = ConversationState::default();
        st.provider_id = ProviderId::ClaudeCode;
        st.session.model = "claude-opus-4-7[1m]".into();
        handle("provider", "kimi", &mut st);
        assert_eq!(st.session.model, "kimi-for-coding");
        handle("provider", "anthropic-oauth", &mut st);
        assert_eq!(st.session.model, "claude-opus-4-7[1m]");
    }
}
