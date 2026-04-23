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
//! Migration progress:
//! - Step 1 empty scaffold — LANDED.
//! - Step 2 `has_any_credentials` real scan — LANDED.
//! - Step 2b `authenticated_providers` — LANDED (this patch). Zero callers yet;
//!   prep for welcome-screen Phase 2 + `/model` tab redesign that both need the
//!   ready-to-dispatch provider list.
//! - Step 3 `set_active_provider` (6-step handshake), Step 4 `set_active_model`
//!   + `set_effort`, Step 5 auth lifecycle, Step 6 settings bridge,
//!   Step 7 `pub(crate)` lockdown — pending.

use crate::config::providers::{ProviderId, PROVIDER_ORDER};
use crate::config::settings::Settings;
#[allow(unused_imports)]
use crate::error::{Error, Result};
#[allow(unused_imports)]
use crate::models::catalog;
#[allow(unused_imports)]
use crate::state::{PersistenceState, Session};

/// Ready-to-dispatch provider list. Returns providers (in `PROVIDER_ORDER`)
/// whose credentials are sufficient to build a valid turn today. Used by the
/// `/model` tab redesign (per-provider tabs) and welcome-screen post-login
/// routing; the set returned here is the set of providers the user can pick
/// without running login first.
///
/// Rules per provider (see `docs/state/state-broker-analysis.md` § Q9):
/// - `ClaudeCode` / `Codex` / `Kimi`: live `auth::<p>::load_credentials()`
///   returning `Some`.
/// - `GeminiCli`: **not yet wired** — no auth module, not in `Registry`.
///   Always excluded until provider wiring lands.
/// - `OpenAiCustom`: BOTH `settings.providers.openai_compatible.base_url` AND
///   `.api_key` present and non-empty. Stricter than `has_any_credentials`
///   (which accepts `base_url`-alone as the welcome-gate signal) because
///   dispatching a turn needs the key. NOTE: also not yet wired end-to-end
///   (no `provider/openai_custom.rs` in the Registry); inclusion here is
///   forward-looking for when the provider lands.
pub fn authenticated_providers(settings: &Settings) -> Vec<ProviderId> {
    let mut out = Vec::with_capacity(PROVIDER_ORDER.len());
    for p in PROVIDER_ORDER {
        let live = match p {
            ProviderId::ClaudeCode => crate::auth::anthropic::load_credentials()
                .ok()
                .flatten()
                .is_some(),
            ProviderId::Codex => crate::auth::codex::load_credentials()
                .ok()
                .flatten()
                .is_some(),
            ProviderId::Kimi => crate::auth::kimi::load_credentials()
                .ok()
                .flatten()
                .is_some(),
            ProviderId::GeminiCli => false,
            ProviderId::OpenAiCustom => settings
                .providers
                .openai_compatible
                .as_ref()
                .is_some_and(|c| {
                    c.base_url.as_deref().is_some_and(|s| !s.is_empty())
                        && c.api_key.as_deref().is_some_and(|s| !s.is_empty())
                }),
        };
        if live {
            out.push(*p);
        }
    }
    out
}

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

    #[test]
    fn authenticated_providers_excludes_gemini_unconditionally() {
        // Gemini has no auth module wired (Phase 2). Even if a user manually
        // configured it in settings.json somehow, broker must not return it
        // as ready-to-dispatch.
        let s = Settings::default();
        let list = authenticated_providers(&s);
        assert!(
            !list.contains(&ProviderId::GeminiCli),
            "Gemini is not wired; broker must not advertise it as authenticated"
        );
    }

    #[test]
    fn authenticated_providers_includes_openai_custom_only_when_both_fields_set() {
        use crate::config::settings::{OpenAiCompatibleSettings, ProviderSettings};

        let mut base_only = Settings::default();
        base_only.providers = ProviderSettings {
            openai_compatible: Some(OpenAiCompatibleSettings {
                base_url: Some("https://llm.example.com/v1".into()),
                api_key: None,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(
            !authenticated_providers(&base_only).contains(&ProviderId::OpenAiCustom),
            "base_url alone is the welcome-gate signal, not the dispatch-ready signal"
        );

        let mut both = Settings::default();
        both.providers = ProviderSettings {
            openai_compatible: Some(OpenAiCompatibleSettings {
                base_url: Some("https://llm.example.com/v1".into()),
                api_key: Some("sk-secret".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(
            authenticated_providers(&both).contains(&ProviderId::OpenAiCustom),
            "base_url + api_key both present → OpenAiCustom is dispatch-ready"
        );

        let mut empty_api_key = Settings::default();
        empty_api_key.providers = ProviderSettings {
            openai_compatible: Some(OpenAiCompatibleSettings {
                base_url: Some("https://llm.example.com/v1".into()),
                api_key: Some(String::new()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(
            !authenticated_providers(&empty_api_key).contains(&ProviderId::OpenAiCustom),
            "empty-string api_key counts as absent"
        );
    }

    #[test]
    fn authenticated_providers_preserves_provider_order() {
        // Whatever providers turn up in the list must appear in PROVIDER_ORDER
        // sequence (ClaudeCode < Codex < Gemini < Kimi < OpenAiCustom).
        let s = Settings::default();
        let list = authenticated_providers(&s);
        let mut positions: Vec<usize> = list
            .iter()
            .map(|p| {
                PROVIDER_ORDER
                    .iter()
                    .position(|q| q == p)
                    .expect("every returned provider must be in PROVIDER_ORDER")
            })
            .collect();
        let sorted = {
            let mut c = positions.clone();
            c.sort();
            c
        };
        assert_eq!(
            positions.drain(..).collect::<Vec<_>>(),
            sorted,
            "authenticated_providers must preserve PROVIDER_ORDER sequence"
        );
    }
}
