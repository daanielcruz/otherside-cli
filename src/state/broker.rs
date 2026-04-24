
use crate::config::providers::{ProviderId, PROVIDER_ORDER};
use crate::config::settings::Settings;
use crate::error::Result;
use crate::tui::state::ConversationState;

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
    
    crate::state::dispatch::set_model(st.session.model.clone());
    Ok(())
}

pub fn set_active_model(st: &mut ConversationState, model: impl Into<String>) -> Result<()> {
    let model = model.into();
    st.switch_model(&model);
    let provider_slug = st.provider_id.slug();
    st.persistence
        .commit_session_defaults(&st.session, provider_slug)?;
    crate::state::dispatch::set_model(model);
    Ok(())
}

pub fn logout_provider(
    st: &mut ConversationState,
    provider: ProviderId,
) -> Result<()> {
    match provider {
        ProviderId::ClaudeCode => crate::auth::anthropic::clear_credentials()?,
        ProviderId::Codex => crate::auth::codex::clear_credentials()?,
        ProviderId::Kimi => crate::auth::kimi::clear_credentials()?,
        ProviderId::GeminiCli => {
            
        }
        ProviderId::OpenAiCustom => {
            if let Some(cfg) = st
                .persistence
                .settings
                .providers
                .openai_compatible
                .as_mut()
            {
                cfg.api_key = None;
            }
            let provider_slug = st.provider_id.slug();
            st.persistence
                .commit_session_defaults(&st.session, provider_slug)?;
        }
    }
    Ok(())
}

pub fn seed_boot_defaults(st: &mut ConversationState) -> Result<()> {
    if st.persistence.settings.default_provider.is_none() {
        st.persistence.settings.default_provider =
            Some(st.provider_id.slug().to_string());
    }
    if st.persistence.settings.default_model.is_none() {
        st.persistence.settings.default_model = Some(st.session.model.clone());
    }
    let provider_slug = st.provider_id.slug();
    st.persistence
        .commit_session_defaults(&st.session, provider_slug)
}

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
        "fast_mode" => {
            st.persistence.settings.fast_mode = Some(value);
            crate::state::dispatch::set_fast_mode(value);
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
    
    if settings
        .providers
        .openai_compatible
        .as_ref()
        .and_then(|o| o.base_url.as_deref())
        .is_some()
    {
        return true;
    }
    
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
        
        let s = Settings::default();
        assert!(s.providers.openai_compatible.is_none());
    }

    #[test]
    fn authenticated_providers_excludes_gemini_unconditionally() {
        
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
        
        use crate::config::providers::ProviderId;
        use crate::config::settings::PermissionMode;
        use crate::tui::state::ConversationState;

        let mut st = ConversationState::default();
        st.session = crate::state::Session::new("claude-opus-4-7[1m]", PermissionMode::Default);
        st.provider_id = ProviderId::ClaudeCode;

        assert_eq!(st.provider_id, ProviderId::ClaudeCode);
        assert_eq!(st.session.model, "claude-opus-4-7[1m]");

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
            fast_mode: false,
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
            fast_mode: false,
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

    fn strip_cfg_test_modules(src: &str) -> String {
        let mut out = String::with_capacity(src.len());
        let mut in_test = false;
        let mut brace_depth = 0i32;
        let mut saw_cfg = false;
        for line in src.lines() {
            if !in_test {
                if line.trim_start().starts_with("#[cfg(test)]") {
                    saw_cfg = true;
                    out.push('\n');
                    continue;
                }
                if saw_cfg {
                    saw_cfg = false;
                    if line.contains("mod ") && line.contains('{') {
                        in_test = true;
                        brace_depth = 1;
                        out.push('\n');
                        continue;
                    }
                }
                out.push_str(line);
                out.push('\n');
            } else {
                for c in line.chars() {
                    if c == '{' { brace_depth += 1; }
                    if c == '}' { brace_depth -= 1; }
                }
                out.push('\n');
                if brace_depth <= 0 {
                    in_test = false;
                }
            }
        }
        out
    }

    #[test]
    fn no_dialog_dismissed_wording_in_production() {
        
        use std::path::Path;

        let needles = [
            "dialog dismissed",
            "Resume cancelled",
            "Background tasks dialog dismissed",
        ];

        fn scan(dir: &Path, needles: &[&str], hits: &mut Vec<String>) {
            if dir.file_name().and_then(|n| n.to_str()) == Some("target") {
                return;
            }
            let entries = match std::fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan(&path, needles, hits);
                    continue;
                }
                if path.extension().and_then(|s| s.to_str()) != Some("rs") {
                    continue;
                }
                let Ok(src) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let stripped = strip_cfg_test_modules(&src);
                for (line_no, line) in stripped.lines().enumerate() {
                    for needle in needles {
                        if line.contains(needle) {
                            hits.push(format!(
                                "{}:{}: {}",
                                path.display(),
                                line_no + 1,
                                line.trim(),
                            ));
                        }
                    }
                }
            }
        }

        let crate_src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut hits = Vec::new();
        scan(&crate_src, &needles, &mut hits);

        assert!(
            hits.is_empty(),
            "dismiss wording leaked outside #[cfg(test)] — silence the panel:\n{}",
            hits.iter().map(String::as_str).collect::<Vec<_>>().join("\n"),
        );
    }

    #[test]
    fn persistence_settings_writers_are_broker_only() {
        
        use std::path::Path;

        fn scan(dir: &Path, hits: &mut Vec<String>) {
            if dir.file_name().and_then(|n| n.to_str()) == Some("target") {
                return;
            }
            let entries = match std::fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan(&path, hits);
                    continue;
                }
                if path.extension().and_then(|s| s.to_str()) != Some("rs") {
                    continue;
                }
                let Ok(src) = std::fs::read_to_string(&path) else {
                    continue;
                };
                
                let stripped = strip_cfg_test_modules(&src);
                for (line_no, line) in stripped.lines().enumerate() {
                    let trimmed = line.trim_start();
                    if trimmed.starts_with("//") || trimmed.starts_with("/*") {
                        continue;
                    }
                    if is_assignment_to_settings_field(line) {
                        hits.push(format!(
                            "{}:{}: {}",
                            path.display(),
                            line_no + 1,
                            line.trim(),
                        ));
                    }
                }
            }
        }

        fn is_assignment_to_settings_field(line: &str) -> bool {
            let needle = "persistence.settings.";
            let Some(idx) = line.find(needle) else { return false; };
            let tail = &line[idx + needle.len()..];
            let mut iter = tail.chars().peekable();
            
            while let Some(&c) = iter.peek() {
                if c.is_alphanumeric() || c == '_' {
                    iter.next();
                } else {
                    break;
                }
            }
            
            while let Some(&c) = iter.peek() {
                if c.is_whitespace() { iter.next(); } else { break; }
            }
            
            match iter.next() {
                Some('=') => !matches!(iter.peek(), Some('=')),
                _ => false,
            }
        }

        let crate_src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut hits = Vec::new();
        scan(&crate_src, &mut hits);

        let allowed_file_suffixes = ["state/broker.rs", "tui/state/mod.rs"];
        let unexpected: Vec<&String> = hits
            .iter()
            .filter(|h| {
                !allowed_file_suffixes
                    .iter()
                    .any(|s| h.contains(s))
            })
            .collect();

        assert!(
            unexpected.is_empty(),
            "non-broker writer(s) of persistence.settings detected — route through state::broker::* instead:\n{}",
            unexpected
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }

    #[test]
    fn logout_provider_strips_openai_custom_api_key_only() {
        
        use crate::config::settings::{OpenAiCompatibleSettings, PermissionMode};
        use crate::tui::state::ConversationState;

        let mut st = ConversationState::default();
        st.session = crate::state::Session::new("gpt-5.4", PermissionMode::Default);
        st.provider_id = ProviderId::OpenAiCustom;
        st.persistence.settings.providers.openai_compatible = Some(OpenAiCompatibleSettings {
            base_url: Some("https://llm.example.com/v1".into()),
            api_key: Some("sk-secret".into()),
            ..Default::default()
        });

        let tmp = std::env::temp_dir().join(format!(
            "broker_logout_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let prev = std::env::var("OTHERSIDE_CONFIG_DIR").ok();
        unsafe { std::env::set_var("OTHERSIDE_CONFIG_DIR", &tmp); }

        let r = logout_provider(&mut st, ProviderId::OpenAiCustom);

        unsafe {
            match prev {
                Some(v) => std::env::set_var("OTHERSIDE_CONFIG_DIR", v),
                None => std::env::remove_var("OTHERSIDE_CONFIG_DIR"),
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);

        assert!(r.is_ok(), "logout must succeed; got {r:?}");
        let cfg = st
            .persistence
            .settings
            .providers
            .openai_compatible
            .as_ref()
            .unwrap();
        assert_eq!(cfg.base_url.as_deref(), Some("https://llm.example.com/v1"));
        assert!(cfg.api_key.is_none(), "api_key must be cleared; got {:?}", cfg.api_key);
    }

    #[test]
    fn logout_gemini_is_noop() {
        use crate::config::settings::PermissionMode;
        use crate::tui::state::ConversationState;
        let mut st = ConversationState::default();
        st.session = crate::state::Session::new("", PermissionMode::Default);
        let r = logout_provider(&mut st, ProviderId::GeminiCli);
        assert!(r.is_ok(), "gemini logout is idempotent no-op");
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
