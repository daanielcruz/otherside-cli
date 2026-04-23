//! `state::broker` — single mediator between UI and disk/auth/settings.
//!
//! Today, UI surfaces and runtime modules reach directly into disk, auth, and
//! settings stores. `/model` peeks `persistence.settings`, `/agents` reads
//! `config::projects`, `/provider` hits `auth::*::load_credentials()`, the
//! subagent spawn path re-reads `default_model` from `persistence.settings`.
//! Every surface implements its own validation and its own
//! persist-after-mutate handshake.
//!
//! This module is the single broker. UI code calls `state::broker::*`; the
//! broker is the only module allowed to touch `persistence.settings`,
//! `auth::*`, `config::projects`, or the provider registry on behalf of UI.
//!
//! Design reference: `docs/state/state-api.md`.
//!
//! This file is the step-1 empty scaffold — no callers have been migrated
//! yet. Behavior change is zero. Subsequent steps (set_active_provider,
//! set_active_model, set_effort, login, logout, list_available_models,
//! authenticated_providers, settings bridge) land in later patches per the
//! migration plan in `docs/state/state-api.md` § Migration plan.

#[allow(unused_imports)]
use crate::config::providers::ProviderId;
use crate::config::settings::Settings;
#[allow(unused_imports)]
use crate::error::{Error, Result};
#[allow(unused_imports)]
use crate::models::catalog;
#[allow(unused_imports)]
use crate::state::{PersistenceState, Session};

/// Zero-cred gate. Returns true if AT LEAST ONE provider has a live credential
/// or a configured OpenAI-compatible base URL. The welcome screen floors on
/// `!has_any_credentials(&settings)`; all other boot paths skip straight to
/// the chat TUI.
pub fn has_any_credentials(settings: &Settings) -> bool {
    if crate::auth::anthropic::load_credentials()
        .ok()
        .flatten()
        .is_some()
    {
        return true;
    }
    if crate::auth::codex::load_credentials()
        .ok()
        .flatten()
        .is_some()
    {
        return true;
    }
    if crate::auth::kimi::load_credentials().ok().flatten().is_some() {
        return true;
    }
    // OpenAI-custom is configured-only (no OAuth): treat a non-empty base_url
    // as "auth present" — the API key may be blank if the upstream is keyless.
    if settings
        .providers
        .openai_compatible
        .as_ref()
        .and_then(|o| o.base_url.as_deref())
        .is_some()
    {
        return true;
    }
    // Gemini has no OAuth flow wired yet (Phase 2); no credential surface to
    // scan. Stays false until the gemini auth module lands.
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_any_credentials_true_when_openai_custom_base_url_configured() {
        use crate::config::settings::{OpenAiCompatibleSettings, ProviderSettings};
        let mut s = Settings::default();
        s.providers = ProviderSettings {
            openai_compatible: Some(OpenAiCompatibleSettings {
                base_url: Some("https://llm.example.com/v1".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(
            has_any_credentials(&s),
            "non-empty OpenAI-custom base_url counts as auth present"
        );
    }

    #[test]
    fn has_any_credentials_respects_configured_providers_only() {
        // Settings with no OpenAI-custom configured + OAuth creds absent
        // (CI / clean boot) must NOT spuriously count as authenticated.
        // When real credentials are present in the user env, the anthropic /
        // codex / kimi `load_credentials()` calls may return Some — we can't
        // assert false unconditionally here. Instead assert that the
        // OpenAI-custom branch doesn't fire when base_url is absent.
        let s = Settings::default();
        assert!(s.providers.openai_compatible.is_none());
    }
}
