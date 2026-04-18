//! `Settings` schema and the serde deserializers that migrate legacy
//! values on read. Split from `config::mod` so that the schema (which
//! grows with every new feature flag) lives alone and the public API
//! stays small.
//!
//! Why a dedicated module: the Settings struct ends up with dozens of
//! fields, several custom `Deserialize` impls (permissionMode legacy
//! migration, camelCase tolerance), and a large `extra` passthrough
//! map. Keeping this out of `mod.rs` means the public entry points
//! (`load`, `load_all`, `credentials_path`) remain skimmable.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Top-level settings, mirrored into `~/.otherside/settings.json`.
///
/// All fields are optional — an empty file round-trips to
/// `Settings::default()`. Unknown keys survive round-trips via `extra`
/// so user config written against a future version of otherside does
/// not get lost on read/write by an older version.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Default provider ID. One of `anthropic-oauth`, `codex`,
    /// `gemini-cli`, `openai-compatible`.
    pub default_provider: Option<String>,

    /// Default model ID, optionally with thinking suffix
    /// (e.g. `claude-opus-4-7(xhigh)`).
    pub default_model: Option<String>,

    /// Log level: `error` / `warn` / `info` / `debug` / `trace`.
    /// Overridden by `--verbose`, `--debug`, or `RUST_LOG`.
    pub log_level: Option<String>,

    /// Interactive permission posture: ask on every mutation (default),
    /// accept non-destructive edits without prompting (acceptEdits),
    /// read-only exploration (plan), or all-allow (yolo — C40).
    pub permission_mode: Option<PermissionMode>,

    /// User consented to yolo mode at least once.
    pub has_accepted_yolo_dialog: Option<bool>,

    /// Auto-run the memory dedup pass on idle.
    pub auto_dedup_mem_enabled: Option<bool>,

    /// Environment variables exported to every tool subprocess. Used by
    /// Phase 2 T3 (Bash / Edit / Write) to propagate user-controlled
    /// env into executed commands.
    pub env: HashMap<String, String>,

    /// Permission rules — allow / deny / ask lists evaluated against
    /// every tool invocation. See `permissions/` (Phase 2 T3).
    pub permissions: Option<PermissionsConfig>,

    /// Pre/post-tool hooks. See `hooks/` (Phase 2 T3).
    pub hooks: Option<HooksConfig>,

    /// Per-provider settings (all optional).
    pub providers: ProviderSettings,

    /// Statusline override — when absent, the native renderer is used.
    /// See `otherside-cli/src/statusline/` for behavior; see C48/C49/C50/C51
    /// for the dual-naming + timeout + layout decisions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statusline: Option<crate::statusline::types::StatuslineConfig>,

    // ----- Enterprise locks (read-only to users when set via policy) -----
    /// Block non-plugin customization paths (stricter than user-set).
    pub strict_plugin_only_customization: Option<bool>,

    /// Only hooks installed via a plugin or managed policy may run.
    pub allow_managed_hooks_only: Option<bool>,

    /// If Some, only these MCP server names may activate.
    pub allowed_mcp_servers: Option<Vec<String>>,

    /// If Some, these MCP server names are blocked regardless of scope.
    pub disabled_mcp_servers: Option<Vec<String>>,

    /// Round-trip passthrough for any key this version doesn't know.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Permission posture values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    Yolo,
}

/// Allow / deny / ask rule lists. Rule-level leniency: a malformed
/// individual rule does not fail the file parse; it's kept around with
/// partial fields so the resolver (§10.4) can emit a warning and drop
/// just that entry.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PermissionsConfig {
    pub allow: Vec<PermissionRule>,
    pub deny: Vec<PermissionRule>,
    pub ask: Vec<PermissionRule>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A single permission rule. Both fields are Optional so a malformed
/// entry survives parse; `is_valid()` tells the resolver whether to
/// keep it.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PermissionRule {
    pub tool_name: Option<String>,
    pub match_pattern: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl PermissionRule {
    /// Rule has the two required fields — resolver drops any whose
    /// `is_valid()` is false and emits a warning.
    pub fn is_valid(&self) -> bool {
        self.tool_name.is_some() && self.match_pattern.is_some()
    }
}

/// Pre/post tool hooks + lifecycle hooks. Field names mirror the
/// hook-event catalog (see `openspec/specs/hooks/` when it lands).
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

/// Single hook entry. `matcher` selects which tool triggers it
/// (`"*"` = any), `command` is the shell string executed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    pub matcher: String,
    pub command: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

/// Per-provider settings (all optional — user opts in per provider).
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

/// Anthropic OAuth provider settings.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct AnthropicOauthSettings {
    pub client_id: Option<String>,
    pub custom_oauth_url: Option<String>,
    pub refresh_safety_margin_seconds: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Codex provider settings (populated post-MVP).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct CodexSettings {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Gemini CLI provider settings (populated post-MVP).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct GeminiCliSettings {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// OpenAI-compatible provider settings — requires user-supplied endpoint.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenAiCompatibleSettings {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
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
        assert_eq!(s.permission_mode, Some(PermissionMode::Default));
        assert_eq!(s.has_accepted_yolo_dialog, Some(false));
        assert_eq!(s.auto_dedup_mem_enabled, Some(true));
        assert!(s.permissions.is_some());
        assert!(s.hooks.is_some());
        assert!(s.providers.openai_compatible.is_some());
        assert_eq!(s.env.get("GIT_AUTHOR_NAME").map(|s| s.as_str()), Some("Elliot"));
        assert_eq!(s.strict_plugin_only_customization, Some(false));
    }

    #[test]
    fn corpus_settings_with_unknown_keys_parses_and_passes_through() {
        let s = parse(&corpus_root().join("settings/with_unknown_keys.json")).unwrap();
        assert!(s.extra.contains_key("experimentalFeatureFromFutureVersion"));
        assert!(s.extra.contains_key("customUserAnnotation"));
        // nested unknown under providers.anthropicOauth survives too
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
        // every rule in this fixture is well-formed.
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
        // §4.8: the file itself MUST parse. The one bad rule keeps
        // partial fields — §10.4 filters it out with a warning.
        let s = parse(&corpus_root().join("settings/invalid_permission_rule.json")).unwrap();
        let p = s.permissions.unwrap();
        let valid_count = p.allow.iter().filter(|r| r.is_valid()).count();
        let invalid_count = p.allow.iter().filter(|r| !r.is_valid()).count();
        assert_eq!(valid_count, 2, "Read and Grep wildcards survive");
        assert_eq!(invalid_count, 2, "missing toolName + missing matchPattern rules flagged");
    }

    #[test]
    fn corpus_malformed_surfaces_parse_error() {
        let res = parse(&corpus_root().join("settings/malformed.json"));
        assert!(res.is_err());
    }

    #[test]
    fn corpus_yolo_mode_parses_canonical_form() {
        let s = parse(&corpus_root().join("settings/yolo_mode.json")).unwrap();
        assert_eq!(s.permission_mode, Some(PermissionMode::Yolo));
        assert_eq!(s.has_accepted_yolo_dialog, Some(true));
    }

    #[test]
    fn yolo_serializes_as_canonical_spelling() {
        let s = Settings {
            permission_mode: Some(PermissionMode::Yolo),
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"permissionMode\":\"yolo\""));
    }

    #[test]
    fn unknown_keys_round_trip_byte_identical_after_normalization() {
        // Read the fixture, serialize back, re-read. The `extra` map +
        // known fields must match on the second read.
        let bytes = std::fs::read(corpus_root().join("settings/with_unknown_keys.json")).unwrap();
        let first: Settings = serde_json::from_slice(&bytes).unwrap();
        let reemitted = serde_json::to_vec(&first).unwrap();
        let second: Settings = serde_json::from_slice(&reemitted).unwrap();
        assert_eq!(first, second);
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
        let only_tool: PermissionRule =
            serde_json::from_str(r#"{"toolName":"Bash"}"#).unwrap();
        assert!(!only_tool.is_valid());

        let only_pattern: PermissionRule =
            serde_json::from_str(r#"{"matchPattern":"cargo *"}"#).unwrap();
        assert!(!only_pattern.is_valid());

        let both: PermissionRule =
            serde_json::from_str(r#"{"toolName":"Bash","matchPattern":"ls"}"#).unwrap();
        assert!(both.is_valid());
    }
}
