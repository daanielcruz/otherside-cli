

use crate::config::settings::Settings;
use crate::error::Result;
use crate::state::Session;

#[derive(Debug, Clone, Default)]
pub struct PersistenceState {

    pub settings: Settings,
}

impl PersistenceState {

    pub fn new(settings: Settings) -> Self {
        Self { settings }
    }

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

    pub fn flush(&self) -> Result<()> {
        let path = crate::config::settings_path()?;
        let json = serde_json::to_vec_pretty(&self.settings)
            .map_err(|e| crate::error::Error::Config(format!("serialize settings: {e}")))?;
        crate::config::write_atomic(&path, &json, false)?;
        Ok(())
    }

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

        p.settings.default_model = None;
        p.settings.default_provider = None;
        p.settings.effort_level = None;

        p.settings.default_provider = Some("anthropic-oauth".into());
        p.settings.default_model = Some(s.model.clone());
        p.settings.effort_level = Some("auto".into());

        assert_eq!(p.settings.default_provider.as_deref(), Some("anthropic-oauth"));
        assert_eq!(p.settings.default_model.as_deref(), Some("claude-opus-4-7[1m]"));
    }

    #[test]
    fn permission_mode_is_not_a_typed_settings_field() {

        let s = Session::new("opus", PermissionMode::Yolo);
        assert_eq!(s.permission_mode, PermissionMode::Yolo);

        let settings = crate::config::Settings::default();
        assert!(settings.extra.is_empty());
    }
}
