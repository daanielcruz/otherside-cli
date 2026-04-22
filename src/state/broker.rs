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
#[allow(unused_imports)]
use crate::config::settings::Settings;
#[allow(unused_imports)]
use crate::error::{Error, Result};
#[allow(unused_imports)]
use crate::models::catalog;
#[allow(unused_imports)]
use crate::state::{PersistenceState, Session};

/// Zero-cred gate. Returns true if AT LEAST ONE provider has valid creds.
pub fn has_any_credentials(_settings: &Settings) -> bool {
    // TODO(broker-step-2): scan auth::*::load_credentials() per provider.
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_any_credentials_defaults_to_false_for_empty_settings() {
        let s = Settings::default();
        assert!(!has_any_credentials(&s));
    }
}
