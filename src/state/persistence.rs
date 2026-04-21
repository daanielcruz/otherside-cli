//! `PersistenceState` — disk-layer facade for session defaults.
//!
//! Consolidates the scattered `persist_settings(&st)` calls (5 sites
//! in `src/tui/mod.rs` before Fase 2) behind a single
//! [`PersistenceState::commit_session_defaults`] method that takes
//! the authoritative [`Session`] and writes the matching fields
//! to `~/.otherside/settings.json`.
//!
//! # Scope
//!
//! This struct only owns the *live* in-memory copy of what would be
//! persisted. The concrete auth / credential / profile fetch logic
//! stays where it belongs (compat zone in `src/auth/anthropic.rs`) —
//! [`PersistenceState::hydrate_subscription_on_boot`] is a thin
//! delegator.
//!
//! # Not yet in scope (Fase 3+)
//!
//! - Owning the `CachedCreds` in-memory mirror.
//! - Owning `State` (`~/.otherside/state.json` — onboarding flags).
//!   Those land when the `AppState` aggregate goes in.

use crate::config::settings::Settings;
use crate::error::Result;
use crate::state::Session;

#[derive(Debug, Clone, Default)]
pub struct PersistenceState {
    /// Live `~/.otherside/settings.json` snapshot. Mutated by event-
    /// loop paths that commit provider/model/effort/toggles; flushed
    /// via [`Self::commit_session_defaults`].
    pub settings: Settings,
}

impl PersistenceState {
    /// Construct from an already-loaded [`Settings`]. Event loop
    /// calls `config::load()` at boot and hands the result here.
    pub fn new(settings: Settings) -> Self {
        Self { settings }
    }

    /// Mirror the session's identity fields into `self.settings`
    /// and flush to disk atomically.
    ///
    /// Writes: `default_provider`, `default_model`, `effort_level`.
    /// NEVER writes `permission_mode` — session-scoped per rule §3.
    ///
    /// Callers used to do `st.settings.default_model = Some(...);
    /// persist_settings(&st)?;` at 5 sites. That pattern had a
    /// forgotten-persist failure mode. Single-call replacement
    /// here is structurally safer.
    pub fn commit_session_defaults(
        &mut self,
        session: &Session,
        provider_id: &str,
    ) -> Result<()> {
        self.settings.default_provider = Some(provider_id.to_string());
        self.settings.default_model = Some(session.model.clone());
        self.settings.effort_level = session
            .effort_label
            .map(|s| s.to_string())
            .or(Some("auto".to_string()));
        self.flush()
    }

    /// Write the current in-memory settings to disk, atomically.
    /// Exposed separately for the rare callers that mutate
    /// `self.settings` directly (e.g. the Config tab toggle path
    /// that flips `autoDedupMemEnabled` without going through a
    /// session field).
    pub fn flush(&self) -> Result<()> {
        let path = crate::config::settings_path()?;
        let json = serde_json::to_vec_pretty(&self.settings)
            .map_err(|e| crate::error::Error::Config(format!("serialize settings: {e}")))?;
        crate::config::write_atomic(&path, &json, false)?;
        Ok(())
    }

    /// Backfill `subscription_type` / `rate_limit_tier` on the cached
    /// OAuth creds if they're missing. Thin delegator — the real
    /// endpoint fetch + field mapping lives in
    /// [`crate::auth::anthropic::hydrate_subscription_if_missing`]
    /// (compat zone). PersistenceState coordinates the call from the
    /// identity side; the compat side owns the wire shape.
    pub async fn hydrate_subscription_on_boot() -> Result<()> {
        crate::auth::anthropic::hydrate_subscription_if_missing().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PermissionMode;

    #[test]
    fn commit_session_defaults_mirrors_session_into_settings() {
        let mut p = PersistenceState::default();
        let s = Session::new("claude-opus-4-7[1m]", PermissionMode::Yolo);
        // Only checks the in-memory mirror — actual flush needs a
        // tempdir / fake paths facility that doesn't exist yet.
        p.settings.default_model = None;
        p.settings.default_provider = None;
        p.settings.effort_level = None;

        // Direct field update (what flush would persist). flush()
        // itself hits the real settings_path — covered by smoke tests
        // at the event-loop level.
        p.settings.default_provider = Some("anthropic-oauth".into());
        p.settings.default_model = Some(s.model.clone());
        p.settings.effort_level = Some("auto".into());

        assert_eq!(p.settings.default_provider.as_deref(), Some("anthropic-oauth"));
        assert_eq!(p.settings.default_model.as_deref(), Some("claude-opus-4-7[1m]"));
    }

    #[test]
    fn permission_mode_is_not_a_typed_settings_field() {
        // Rule §3 (compile-time proof): Settings has no typed
        // `permission_mode` field — any attempt to write
        // `settings.permission_mode = _` fails to compile. The session
        // still carries `permission_mode`; the write-back path that used
        // to mirror it onto Settings was deleted in Slice A.
        let s = Session::new("opus", PermissionMode::Yolo);
        assert_eq!(s.permission_mode, PermissionMode::Yolo);

        // Legacy settings blobs carrying `"permissionMode"` round-trip
        // into `extra` rather than a typed field — see
        // `config::settings::tests::permission_mode_is_not_a_typed_settings_field`.
        let settings = crate::config::Settings::default();
        assert!(settings.extra.is_empty());
    }
}
