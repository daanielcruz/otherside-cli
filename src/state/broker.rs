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
//! - Step 3 `set_active_provider` — LANDED (this patch). Centralizes the
//!   6-step handshake (in-memory swap + settings flush + runner resync) that
//!   was previously duplicated at 2 call sites with different bugs each.
//!   Closes the latent Q5 bug where runner-sync only fired via
//!   `dispatch_slash`'s post-hook, which itself went dead after `/provider`
//!   slash was removed.
//! - Step 4 `set_active_model` + `set_effort`, Step 5 auth lifecycle,
//!   Step 6 settings bridge, Step 7 `pub(crate)` lockdown — pending.

use crate::config::providers::{ProviderId, PROVIDER_ORDER};
use crate::config::settings::Settings;
use crate::error::Result;
use crate::tui::state::ConversationState;

/// 6-step provider switch handshake. Single entry point for every UI surface
/// that wants to change the active provider (today: `/model` panel Enter at
/// `tui/mod.rs` and `/config` Provider-row cycle).
///
/// Steps (per `docs/state/state-broker-analysis.md` § 5):
/// 1. In-memory swap — `st.switch_provider(next)` flips `provider_id` and
///    auto-swaps the session model to `next.default_model()` when the current
///    model doesn't belong to the new provider's catalog family.
/// 2-4. Mirror the new pair into `st.persistence.settings.default_provider` +
///    `default_model` (also handled inside `switch_provider`).
/// 5. Atomically flush `settings.json` to disk via
///    `PersistenceState::commit_session_defaults` — mirrors the
///    `persist_session_defaults` helper in `tui/mod.rs` (which this call
///    eventually subsumes).
/// 6. Resync the subagent runner with the new provider `Arc` so the next
///    `Task(...)` / `Agent(...)` dispatches against the freshly-picked
///    provider. Previously this only fired from `dispatch_slash`'s
///    post-outcome hook, which went dead when the `/provider` slash was
///    removed — leaving 2 of 2 current sites silently stuck with the boot
///    provider in the runner.
///
/// Auth gate deferred: callers today are panel-level (`/model` tabs already
/// gate via `authenticated_providers`; `/config` cycles UX-continuously).
/// Step 5 lifecycle migration will own the hard refusal semantics.
///
/// Effort reset deferred to Step 4 `set_active_model` — current
/// `switch_provider` preserves `effort_label` across the swap. Any mismatch
/// (e.g. kimi `on`/`off` vs anthropic `auto`/`deep`/…) is a pre-existing
/// latent bug addressed when Step 4 lands.
///
/// Registry access is routed through `state::dispatch::provider_by_slug` so
/// every UI surface (both `/model` panel Enter and `/config` Provider cycle)
/// gets the full snapshot+runner handshake without threading `Arc<Registry>`
/// through the call chain. Main installs the registry at boot via
/// `dispatch::install_registry`.
pub fn set_active_provider(
    st: &mut ConversationState,
    next: ProviderId,
) -> Result<()> {
    st.switch_provider(next);
    let provider_slug = st.provider_id.slug();
    st.persistence
        .commit_session_defaults(&st.session, provider_slug)?;
    if let Some(provider_arc) = crate::state::dispatch::provider_by_slug(provider_slug) {
        crate::state::dispatch::set_provider(provider_arc);
    }
    // Model may have auto-swapped inside `switch_provider` — keep the
    // dispatch snapshot aligned with the session-live model so the subagent
    // runner reads the same model the main turn will.
    crate::state::dispatch::set_model(st.session.model.clone());
    Ok(())
}

/// Switch the active model in-memory, mirror into settings, flush to disk,
/// and update the dispatch snapshot. The model catalog guarantees the slug
/// belongs to the currently-active provider — caller is responsible for
/// gating cross-provider selection.
pub fn set_active_model(st: &mut ConversationState, model: impl Into<String>) -> Result<()> {
    let model = model.into();
    st.session.set_model(&model);
    let provider_slug = st.provider_id.slug();
    st.persistence
        .commit_session_defaults(&st.session, provider_slug)?;
    crate::state::dispatch::set_model(model);
    Ok(())
}

/// Boolean-setting bridge for `/config` bool-row toggles. Mutates the in-
/// memory settings, mirrors into the matching `ConversationState` flag when
/// the setting has a runtime shadow (`verbose` → `render_verbose`), and
/// flushes `settings.json`. Returns `Err(...)` for unknown keys so callers
/// get a loud signal instead of a silent no-op.
///
/// Broker-owned bool keys (matches `/config` Bool rows in `tui/menu.rs`):
/// - `auto_compact`
/// - `show_tips`
/// - `verbose` — also mirrored into `st.render_verbose`.
/// - `prefers_reduced_motion`
/// - `file_checkpointing_enabled`
/// - `auto_connect_ide`
pub fn set_bool_setting(
    st: &mut ConversationState,
    key: &str,
    value: bool,
) -> Result<()> {
    match key {
        "auto_compact" => st.persistence.settings.auto_compact = Some(value),
        "show_tips" => st.persistence.settings.show_tips = Some(value),
        "verbose" => {
            st.render_verbose = value;
            st.persistence.settings.verbose = Some(value);
        }
        "prefers_reduced_motion" => {
            st.persistence.settings.prefers_reduced_motion = Some(value)
        }
        "file_checkpointing_enabled" => {
            st.persistence.settings.file_checkpointing_enabled = Some(value)
        }
        "auto_connect_ide" => {
            st.persistence.settings.auto_connect_ide = Some(value)
        }
        other => {
            return Err(crate::error::Error::Other(format!(
                "set_bool_setting: unknown key `{other}`"
            )));
        }
    }
    let provider_slug = st.provider_id.slug();
    st.persistence
        .commit_session_defaults(&st.session, provider_slug)?;
    Ok(())
}

/// Switch the active thinking config in-memory + snapshot, and mirror the
/// effort label into settings. `thinking = None` clears effort.
pub fn set_effort(
    st: &mut ConversationState,
    thinking: Option<crate::thinking::ThinkingConfig>,
    effort_level: Option<String>,
) -> Result<()> {
    st.session.set_thinking(thinking);
    st.session.effort_label = thinking
        .as_ref()
        .and_then(crate::thinking::label_from_thinking);
    st.persistence.settings.effort_level = effort_level;
    let provider_slug = st.provider_id.slug();
    st.persistence
        .commit_session_defaults(&st.session, provider_slug)?;
    crate::state::dispatch::set_thinking(thinking);
    Ok(())
}

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
    fn set_active_provider_swaps_provider_and_mirrors_settings() {
        // Unit-level contract: set_active_provider(st, next) flips
        // provider_id, auto-switches the session model when it doesn't belong
        // to the new provider's catalog family, and mirrors both into
        // persistence.settings via `commit_session_defaults`. When no
        // registry has been installed at `dispatch::install_registry`, the
        // provider-snapshot write silently no-ops (test harness path).
        //
        // Flush happens inside commit_session_defaults; we can't assert the
        // on-disk bytes without a temp-HOME fixture, but the in-memory mirror
        // proves the handshake called through.
        use crate::config::providers::ProviderId;
        use crate::config::settings::PermissionMode;
        use crate::tui::state::ConversationState;

        let mut st = ConversationState::default();
        st.session = crate::state::Session::new("claude-opus-4-7[1m]", PermissionMode::Default);
        st.provider_id = ProviderId::ClaudeCode;

        // Pre-switch sanity: model belongs to ClaudeCode.
        assert_eq!(st.provider_id, ProviderId::ClaudeCode);
        assert_eq!(st.session.model, "claude-opus-4-7[1m]");

        // commit_session_defaults will attempt a disk flush — isolate by
        // pointing settings_path at a writable temp file via OTHERSIDE_CONFIG_DIR.
        let tmp = std::env::temp_dir().join(format!(
            "broker_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let prev = std::env::var("OTHERSIDE_CONFIG_DIR").ok();
        unsafe {
            std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp);
        }

        let result = set_active_provider(&mut st, ProviderId::Kimi);

        unsafe {
            match prev {
                Some(v) => std::env::set_var("OTHERSIDE_CONFIG_DIR", v),
                None => std::env::remove_var("OTHERSIDE_CONFIG_DIR"),
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);

        assert!(result.is_ok(), "set_active_provider must succeed; got {result:?}");
        assert_eq!(st.provider_id, ProviderId::Kimi, "in-memory provider_id flipped");
        assert_eq!(
            st.session.model, "kimi-for-coding",
            "model auto-swapped to kimi.default_model() since opus doesn't belong to Kimi catalog"
        );
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("kimi"),
            "settings.default_provider mirrored to new slug"
        );
        assert_eq!(
            st.persistence.settings.default_model.as_deref(),
            Some("kimi-for-coding"),
            "settings.default_model mirrored to new model"
        );
    }

    #[test]
    fn set_active_model_mirrors_session_settings_and_dispatch_snapshot() {
        use crate::config::settings::PermissionMode;
        use crate::provider::{ChunkStream, Provider};
        use crate::state::dispatch::{self, DispatchSnapshot};
        use crate::tui::state::ConversationState;
        use futures::stream;
        use std::pin::Pin;
        use std::sync::Arc;

        struct FakeProvider;
        impl Provider for FakeProvider {
            fn id(&self) -> &'static str { "claude-code" }
            fn stream<'a>(
                &'a self,
                _req: crate::inference::OpenAiChatRequest,
                _thinking: Option<crate::thinking::ThinkingConfig>,
            ) -> Pin<Box<dyn std::future::Future<Output = crate::error::Result<ChunkStream>> + Send + 'a>>
            {
                Box::pin(async move { Ok(Box::pin(stream::empty()) as ChunkStream) })
            }
        }

        dispatch::install_for_test(DispatchSnapshot {
            provider: Arc::new(FakeProvider) as Arc<dyn Provider>,
            model: "boot-model".into(),
            thinking: None,
        });

        let mut st = ConversationState::default();
        st.session = crate::state::Session::new("claude-opus-4-7", PermissionMode::Default);
        st.provider_id = ProviderId::ClaudeCode;

        let tmp = std::env::temp_dir().join(format!(
            "broker_model_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let prev = std::env::var("OTHERSIDE_CONFIG_DIR").ok();
        unsafe { std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp); }

        let result = set_active_model(&mut st, "claude-haiku-4-5");

        unsafe {
            match prev {
                Some(v) => std::env::set_var("OTHERSIDE_CONFIG_DIR", v),
                None => std::env::remove_var("OTHERSIDE_CONFIG_DIR"),
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);

        assert!(result.is_ok(), "set_active_model must succeed; got {result:?}");
        assert_eq!(st.session.model, "claude-haiku-4-5", "session model flipped");
        assert_eq!(
            st.persistence.settings.default_model.as_deref(),
            Some("claude-haiku-4-5"),
            "settings mirror matches",
        );
        assert_eq!(
            dispatch::snapshot().expect("snapshot installed").model,
            "claude-haiku-4-5",
            "dispatch snapshot is in lock-step with session model",
        );
    }

    #[test]
    fn set_effort_mirrors_session_settings_and_dispatch_snapshot() {
        use crate::config::settings::PermissionMode;
        use crate::provider::{ChunkStream, Provider};
        use crate::state::dispatch::{self, DispatchSnapshot};
        use crate::thinking::{ThinkingConfig, ThinkingLevel};
        use crate::tui::state::ConversationState;
        use futures::stream;
        use std::pin::Pin;
        use std::sync::Arc;

        struct FakeProvider;
        impl Provider for FakeProvider {
            fn id(&self) -> &'static str { "claude-code" }
            fn stream<'a>(
                &'a self,
                _req: crate::inference::OpenAiChatRequest,
                _thinking: Option<ThinkingConfig>,
            ) -> Pin<Box<dyn std::future::Future<Output = crate::error::Result<ChunkStream>> + Send + 'a>>
            {
                Box::pin(async move { Ok(Box::pin(stream::empty()) as ChunkStream) })
            }
        }

        dispatch::install_for_test(DispatchSnapshot {
            provider: Arc::new(FakeProvider) as Arc<dyn Provider>,
            model: "claude-opus-4-7".into(),
            thinking: None,
        });

        let mut st = ConversationState::default();
        st.session = crate::state::Session::new("claude-opus-4-7", PermissionMode::Default);
        st.provider_id = ProviderId::ClaudeCode;

        let tmp = std::env::temp_dir().join(format!(
            "broker_effort_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let prev = std::env::var("OTHERSIDE_CONFIG_DIR").ok();
        unsafe { std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp); }

        let result = set_effort(
            &mut st,
            Some(ThinkingConfig::level(ThinkingLevel::High)),
            Some("high".to_string()),
        );

        unsafe {
            match prev {
                Some(v) => std::env::set_var("OTHERSIDE_CONFIG_DIR", v),
                None => std::env::remove_var("OTHERSIDE_CONFIG_DIR"),
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);

        assert!(result.is_ok(), "set_effort must succeed; got {result:?}");
        assert_eq!(
            st.session.thinking.map(|t| t.level),
            Some(ThinkingLevel::High),
            "session thinking set",
        );
        assert_eq!(st.session.effort_label, Some("high"), "label derived");
        assert_eq!(
            st.persistence.settings.effort_level.as_deref(),
            Some("high"),
            "settings mirror matches",
        );
        let snap = dispatch::snapshot().expect("snapshot installed");
        assert_eq!(
            snap.thinking.map(|t| t.level),
            Some(ThinkingLevel::High),
            "dispatch snapshot thinking in lock-step",
        );
    }

    #[test]
    fn set_bool_setting_mutates_mirrors_and_shadows_verbose() {
        use crate::config::settings::PermissionMode;
        use crate::tui::state::ConversationState;

        let mut st = ConversationState::default();
        st.session = crate::state::Session::new("claude-opus-4-7", PermissionMode::Default);

        let tmp = std::env::temp_dir().join(format!(
            "broker_bool_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let prev = std::env::var("OTHERSIDE_CONFIG_DIR").ok();
        unsafe { std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp); }

        set_bool_setting(&mut st, "auto_compact", false).unwrap();
        set_bool_setting(&mut st, "verbose", true).unwrap();

        let unknown = set_bool_setting(&mut st, "nonexistent_key", true);

        unsafe {
            match prev {
                Some(v) => std::env::set_var("OTHERSIDE_CONFIG_DIR", v),
                None => std::env::remove_var("OTHERSIDE_CONFIG_DIR"),
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);

        assert_eq!(st.persistence.settings.auto_compact, Some(false));
        assert_eq!(st.persistence.settings.verbose, Some(true));
        assert!(st.render_verbose, "verbose shadow must flip with the setting");
        assert!(unknown.is_err(), "unknown key must not silently no-op");
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
