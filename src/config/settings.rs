use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub default_provider: Option<String>,

    pub default_model: Option<String>,

    pub log_level: Option<String>,

    pub has_accepted_yolo_dialog: Option<bool>,

    pub auto_dedup_mem_enabled: Option<bool>,

    pub env: HashMap<String, String>,

    pub permissions: Option<PermissionsConfig>,

    pub hooks: Option<HooksConfig>,

    pub providers: ProviderSettings,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statusline: Option<crate::statusline::types::StatuslineConfig>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort_level: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_tips: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefers_reduced_motion: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_checkpointing_enabled: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_style: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_connect_ide: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_mode: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caveman_enabled: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtk_enabled: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_verification_enabled: Option<bool>,

    pub strict_plugin_only_customization: Option<bool>,

    pub allow_managed_hooks_only: Option<bool>,

    pub allowed_mcp_servers: Option<Vec<String>>,

    pub disabled_mcp_servers: Option<Vec<String>>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    #[serde(rename = "bypassPermissions", alias = "yolo")]
    Yolo,
    DontAsk,
}

impl Default for PermissionMode {
    fn default() -> Self {
        PermissionMode::Default
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PermissionsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<PermissionMode>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_bypass_permissions_mode: Option<String>,

    pub allow: Vec<PermissionRule>,
    pub deny: Vec<PermissionRule>,
    pub ask: Vec<PermissionRule>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_directories: Vec<String>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PermissionRule {
    pub tool_name: Option<String>,
    pub match_pattern: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl PermissionRule {
    pub fn is_valid(&self) -> bool {
        self.tool_name
            .as_deref()
            .map(|tool| !tool.trim().is_empty())
            .unwrap_or(false)
    }
}

impl<'de> Deserialize<'de> for PermissionRule {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum WireRule {
            String(String),
            Object(ObjectRule),
        }

        #[derive(Default, Deserialize)]
        #[serde(default, rename_all = "camelCase")]
        struct ObjectRule {
            tool_name: Option<String>,
            match_pattern: Option<String>,
            #[serde(flatten)]
            extra: Map<String, Value>,
        }

        match WireRule::deserialize(deserializer)? {
            WireRule::Object(rule) => Ok(Self {
                tool_name: rule.tool_name,
                match_pattern: rule.match_pattern,
                extra: rule.extra,
            }),
            WireRule::String(raw) => Ok(Self::from_rule_string(&raw)),
        }
    }
}

impl PermissionRule {
    fn from_rule_string(raw: &str) -> Self {
        match crate::permissions::matcher::parse(raw) {
            Ok(parsed) => {
                let tool_name = match parsed.tool {
                    crate::permissions::MatcherTool::Any => "*".to_string(),
                    crate::permissions::MatcherTool::Named(name) => name,
                };
                Self {
                    tool_name: Some(tool_name),
                    match_pattern: parsed.pattern,
                    extra: Default::default(),
                }
            }
            Err(_) => Self {
                tool_name: None,
                match_pattern: Some(raw.to_string()),
                extra: Default::default(),
            },
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct HooksConfig {
    pub pre_tool_use: Vec<HookEntry>,
    pub post_tool_use: Vec<HookEntry>,
    pub user_prompt_submit: Vec<HookEntry>,
    pub stop: Vec<HookEntry>,
    pub subagent_stop: Vec<HookEntry>,
    pub pre_compact: Vec<HookEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    pub matcher: String,
    pub command: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_tag: Option<String>,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

impl HookEntry {
    pub fn timeout_ms(&self) -> u64 {
        self.timeout.unwrap_or(60_000)
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderSettings {
    pub anthropic_oauth: Option<AnthropicOauthSettings>,
    pub codex: Option<CodexSettings>,
    pub gemini_cli: Option<GeminiCliSettings>,
    pub openai_compatible: Option<OpenAiCompatibleSettings>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct AnthropicOauthSettings {
    pub client_id: Option<String>,
    pub custom_oauth_url: Option<String>,
    pub refresh_safety_margin_seconds: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct CodexSettings {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct GeminiCliSettings {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenAiCompatibleSettings {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl OpenAiCompatibleSettings {
    pub const DEFAULT_BASE_URL: &'static str = "http://127.0.0.1:8317";
    pub const DEFAULT_MODEL: &'static str = "gpt-5.5";

    pub fn resolved_base_url(&self) -> String {
        self.base_url
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(Self::DEFAULT_BASE_URL)
            .to_string()
    }

    pub fn resolved_model(&self) -> String {
        self.model
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(Self::DEFAULT_MODEL)
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn corpus_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config_corpus")
    }

    fn parse(path: &PathBuf) -> Result<Settings, serde_json::Error> {
        let bytes = std::fs::read(path).expect("corpus file should exist");
        serde_json::from_slice::<Settings>(&bytes)
    }

    #[test]
    fn corpus_settings_minimal_parses() {
        let s = parse(&corpus_root().join("settings/minimal.json")).unwrap();
        assert_eq!(s.default_provider.as_deref(), Some("anthropic-oauth"));
    }

    #[test]
    fn corpus_settings_full_parses() {
        let s = parse(&corpus_root().join("settings/full.json")).unwrap();
        assert_eq!(s.default_provider.as_deref(), Some("anthropic-oauth"));
        assert_eq!(s.has_accepted_yolo_dialog, Some(false));
        assert_eq!(s.auto_dedup_mem_enabled, Some(true));
        assert!(s.permissions.is_some());
        assert!(s.hooks.is_some());
        assert!(s.providers.openai_compatible.is_some());
        assert_eq!(
            s.env.get("GIT_AUTHOR_NAME").map(|s| s.as_str()),
            Some("Elliot")
        );
        assert_eq!(s.strict_plugin_only_customization, Some(false));
        assert!(
            s.extra.contains_key("permissionMode"),
            "rule §3: permissionMode in settings.json falls through to extra and never seeds the session"
        );
    }

    #[test]
    fn corpus_settings_with_unknown_keys_parses_and_passes_through() {
        let s = parse(&corpus_root().join("settings/with_unknown_keys.json")).unwrap();
        assert!(s.extra.contains_key("experimentalFeatureFromFutureVersion"));
        assert!(s.extra.contains_key("customUserAnnotation"));

        let ant = s.providers.anthropic_oauth.as_ref().unwrap();
        assert!(ant.extra.contains_key("futureProviderKnob"));
    }

    #[test]
    fn corpus_settings_with_permission_rules_parses() {
        let s = parse(&corpus_root().join("settings/with_permission_rules.json")).unwrap();
        let p = s.permissions.unwrap();
        assert!(p.allow.len() >= 10);
        assert!(p.deny.len() >= 5);
        assert!(p.ask.len() >= 2);

        assert!(p.allow.iter().all(PermissionRule::is_valid));
        assert!(p.deny.iter().all(PermissionRule::is_valid));
    }

    #[test]
    fn corpus_settings_with_hooks_parses() {
        let s = parse(&corpus_root().join("settings/with_hooks.json")).unwrap();
        let h = s.hooks.unwrap();
        assert_eq!(h.pre_tool_use.len(), 3);
        assert_eq!(h.post_tool_use.len(), 2);
        assert_eq!(h.user_prompt_submit.len(), 1);
        assert_eq!(h.stop.len(), 1);
    }

    #[test]
    fn corpus_invalid_permission_rule_keeps_file_parseable() {
        let s = parse(&corpus_root().join("settings/invalid_permission_rule.json")).unwrap();
        let p = s.permissions.unwrap();
        let valid_count = p.allow.iter().filter(|r| r.is_valid()).count();
        let invalid_count = p.allow.iter().filter(|r| !r.is_valid()).count();
        assert_eq!(valid_count, 3, "tool-wide Bash plus Read/Grep survive");
        assert_eq!(invalid_count, 1, "missing toolName rule flagged");
    }

    #[test]
    fn corpus_malformed_surfaces_parse_error() {
        let res = parse(&corpus_root().join("settings/malformed.json"));
        assert!(res.is_err());
    }

    #[test]
    fn corpus_yolo_mode_parses_canonical_form() {
        let s = parse(&corpus_root().join("settings/yolo_mode.json")).unwrap();
        assert_eq!(s.has_accepted_yolo_dialog, Some(true));
        assert!(
            s.extra.contains_key("permissionMode"),
            "rule §3: permissionMode survives as passthrough extra, not a typed field"
        );
    }

    #[test]
    fn permission_mode_is_not_a_typed_settings_field() {
        let json = r#"{"permissionMode":"yolo","defaultProvider":"anthropic-oauth"}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.default_provider.as_deref(), Some("anthropic-oauth"));
        assert_eq!(
            s.extra.get("permissionMode"),
            Some(&Value::String("yolo".to_string()))
        );
    }

    #[test]
    fn unknown_keys_round_trip_byte_identical_after_normalization() {
        let bytes = std::fs::read(corpus_root().join("settings/with_unknown_keys.json")).unwrap();
        let first: Settings = serde_json::from_slice(&bytes).unwrap();
        let reemitted = serde_json::to_vec(&first).unwrap();
        let second: Settings = serde_json::from_slice(&reemitted).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn caveman_and_rtk_defaults_are_none_when_key_missing() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.caveman_enabled.is_none());
        assert!(s.rtk_enabled.is_none());
    }

    #[test]
    fn caveman_and_rtk_round_trip_through_serde() {
        let s = Settings {
            caveman_enabled: Some(false),
            rtk_enabled: Some(true),
            ..Default::default()
        };
        let bytes = serde_json::to_vec(&s).unwrap();
        let back: Settings = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.caveman_enabled, Some(false));
        assert_eq!(back.rtk_enabled, Some(true));
    }

    #[test]
    fn caveman_and_rtk_deserialize_from_camelcase_keys() {
        let json = r#"{"cavemanEnabled":false,"rtkEnabled":false}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.caveman_enabled, Some(false));
        assert_eq!(s.rtk_enabled, Some(false));
    }

    #[test]
    fn hook_entry_preserves_extra() {
        let json = r#"{ "matcher": "*", "command": "x", "custom": 42 }"#;
        let h: HookEntry = serde_json::from_str(json).unwrap();
        assert_eq!(h.matcher, "*");
        assert_eq!(h.command, "x");
        assert_eq!(h.extra.get("custom"), Some(&Value::from(42)));
    }

    #[test]
    fn permission_rule_with_missing_field_is_invalid_but_parseable() {
        let only_tool: PermissionRule = serde_json::from_str(r#"{"toolName":"Bash"}"#).unwrap();
        assert!(only_tool.is_valid());

        let only_pattern: PermissionRule =
            serde_json::from_str(r#"{"matchPattern":"cargo *"}"#).unwrap();
        assert!(!only_pattern.is_valid());

        let both: PermissionRule =
            serde_json::from_str(r#"{"toolName":"Bash","matchPattern":"ls"}"#).unwrap();
        assert!(both.is_valid());
    }

    #[test]
    fn permissions_parse_upstream_string_rules() {
        let json = r#"{
            "permissions": {
                "allow": ["Read", "Bash(git diff*)", "Write(**/notes.md)"],
                "deny": ["Bash(rm -rf *)"],
                "ask": ["Bash(git push*)"]
            }
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        let p = s.permissions.unwrap();
        assert_eq!(p.allow[0].tool_name.as_deref(), Some("Read"));
        assert_eq!(p.allow[0].match_pattern, None);
        assert_eq!(p.allow[1].tool_name.as_deref(), Some("Bash"));
        assert_eq!(p.allow[1].match_pattern.as_deref(), Some("git diff*"));
        assert!(p.allow.iter().all(PermissionRule::is_valid));
        assert_eq!(p.deny[0].match_pattern.as_deref(), Some("rm -rf *"));
        assert_eq!(p.ask[0].match_pattern.as_deref(), Some("git push*"));
    }

    #[test]
    fn permissions_default_mode_parses_upstream_modes() {
        let json = r#"{
            "permissions": {
                "defaultMode": "bypassPermissions",
                "disableBypassPermissionsMode": "disable",
                "additionalDirectories": ["/tmp/project"]
            }
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        let p = s.permissions.unwrap();
        assert_eq!(p.default_mode, Some(PermissionMode::Yolo));
        assert_eq!(
            p.disable_bypass_permissions_mode.as_deref(),
            Some("disable")
        );
        assert_eq!(p.additional_directories, vec!["/tmp/project"]);

        let dont_ask: PermissionMode = serde_json::from_str(r#""dontAsk""#).unwrap();
        assert_eq!(dont_ask, PermissionMode::DontAsk);

        let encoded = serde_json::to_string(&PermissionMode::Yolo).unwrap();
        assert_eq!(encoded, r#""bypassPermissions""#);
    }
}
