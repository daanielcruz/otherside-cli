

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::settings::PermissionMode;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatuslineInput {
    pub session_id: String,
    pub transcript_path: String,
    pub cwd: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,

    pub model: ModelInput,
    pub workspace: WorkspaceInput,
    pub version: String,
    pub output_style: OutputStyleInput,
    pub cost: CostInput,
    pub context_window: ContextWindowInput,
    pub exceeds_200k_tokens: bool,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<RateLimitsInput>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vim: Option<VimInput>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentInput>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteInput>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeInput>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelInput {
    pub id: String,
    pub display_name: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceInput {
    pub current_dir: String,
    pub project_dir: String,
    pub added_dirs: Vec<String>,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputStyleInput {
    pub name: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CostInput {
    pub total_cost_usd: f64,
    pub total_duration_ms: u64,
    pub total_api_duration_ms: u64,
    pub total_lines_added: u64,
    pub total_lines_removed: u64,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextWindowInput {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub context_window_size: u64,
    pub current_usage: u64,
    pub used_percentage: u64,
    pub remaining_percentage: u64,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RateLimitsInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<RateWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<RateWindow>,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RateWindow {
    pub used_percentage: f64,
    pub resets_at: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VimInput {
    pub mode: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentInput {
    pub name: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInput {
    pub session_id: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeInput {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub original_cwd: String,
    pub original_branch: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StatuslineConfig {

    Native {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        padding: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        theme: Option<StatuslineTheme>,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },

    Command {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        padding: Option<u8>,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },
}

impl Default for StatuslineConfig {
    fn default() -> Self {
        StatuslineConfig::Native {
            padding: None,
            theme: None,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct StatuslineTheme {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StatuslineCtx {
    pub payload: StatuslineInput,
    pub terminal_width: u16,
    pub home_dir: Option<String>,
    pub permission_mode: PermissionMode,
    pub custom_env: HashMap<String, String>,
    pub provider_id: String,
}

impl StatuslineCtx {

    pub fn minimal_for_test() -> Self {
        Self {
            payload: StatuslineInput {
                session_id: "test-session".into(),
                transcript_path: "/tmp/transcript.jsonl".into(),
                cwd: "/tmp/demo".into(),
                session_name: None,
                model: ModelInput {
                    id: "claude-opus-4-7".into(),
                    display_name: "Opus 4.7".into(),
                    extra: Map::new(),
                },
                workspace: WorkspaceInput {
                    current_dir: "/tmp/demo".into(),
                    project_dir: "/tmp/demo".into(),
                    added_dirs: vec![],
                    extra: Map::new(),
                },
                version: "0.0.1".into(),
                output_style: OutputStyleInput {
                    name: "default".into(),
                    extra: Map::new(),
                },
                cost: CostInput {
                    total_cost_usd: 0.0,
                    total_duration_ms: 0,
                    total_api_duration_ms: 0,
                    total_lines_added: 0,
                    total_lines_removed: 0,
                    extra: Map::new(),
                },
                context_window: ContextWindowInput {
                    total_input_tokens: 0,
                    total_output_tokens: 0,
                    context_window_size: 200_000,
                    current_usage: 0,
                    used_percentage: 0,
                    remaining_percentage: 100,
                    extra: Map::new(),
                },
                exceeds_200k_tokens: false,
                rate_limits: None,
                vim: None,
                agent: None,
                remote: None,
                worktree: None,
                extra: Map::new(),
            },
            terminal_width: 80,
            home_dir: Some("/tmp".into()),
            permission_mode: PermissionMode::Default,
            custom_env: HashMap::new(),
            provider_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StatuslineLine {
    pub content: String,
    pub width_cols: u16,
}

impl StatuslineLine {

    pub fn from_text(s: &str) -> Self {
        let content = s.trim_end_matches('\n').to_string();
        let width_cols = display_width(&content);
        Self { content, width_cols }
    }
}

pub fn display_width(s: &str) -> u16 {
    use unicode_width::UnicodeWidthChar;
    let mut in_escape = false;
    let mut width: usize = 0;
    for ch in s.chars() {
        if in_escape {
            if ch.is_ascii_alphabetic() {
                in_escape = false;
            }
            continue;
        }
        if ch == '\x1b' {
            in_escape = true;
            continue;
        }
        width = width.saturating_add(ch.width().unwrap_or(0));
    }
    u16::try_from(width).unwrap_or(u16::MAX)
}

#[derive(Debug, thiserror::Error)]
pub enum StatuslineError {
    #[error("failed to spawn statusline command: {0}")]
    SpawnFailed(std::io::Error),
    #[error("statusline command timed out")]
    Timeout,
    #[error("statusline command exited with status {code}")]
    NonZeroExit { code: i32 },
    #[error("statusline command stdout was not utf-8")]
    OutputNotUtf8,
    #[error("statusline command produced empty output")]
    EmptyOutput,
    #[error("failed to serialize statusline payload: {0}")]
    PayloadSerialize(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Default)]
pub struct StatuslineCache {
    last_hash: Option<u64>,
    last_line: Option<StatuslineLine>,
}

impl StatuslineCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: u64) -> Option<&StatuslineLine> {
        if self.last_hash == Some(key) {
            self.last_line.as_ref()
        } else {
            None
        }
    }

    pub fn store(&mut self, key: u64, line: StatuslineLine) {
        self.last_hash = Some(key);
        self.last_line = Some(line);
    }

    pub fn invalidate(&mut self) {
        self.last_hash = None;
        self.last_line = None;
    }
}

pub fn render_key(ctx: &StatuslineCtx) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    ctx.payload.model.id.hash(&mut h);
    ctx.payload.model.display_name.hash(&mut h);
    ctx.payload.workspace.current_dir.hash(&mut h);
    ctx.payload.workspace.project_dir.hash(&mut h);
    ctx.payload.exceeds_200k_tokens.hash(&mut h);
    ctx.payload.context_window.used_percentage.hash(&mut h);
    (ctx.permission_mode as u8).hash(&mut h);
    ctx.terminal_width.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_width_counts_plain_chars() {
        assert_eq!(display_width("hello"), 5);
    }

    #[test]
    fn display_width_ignores_ansi_escape() {
        assert_eq!(display_width("\x1b[38;2;81;21;140mhello\x1b[0m"), 5);
    }

    #[test]
    fn display_width_counts_multibyte_chars() {

        assert_eq!(display_width("한"), 2);
    }

    #[test]
    fn line_from_text_strips_trailing_newline() {
        let line = StatuslineLine::from_text("hello\n");
        assert_eq!(line.content, "hello");
        assert_eq!(line.width_cols, 5);
    }

    #[test]
    fn render_key_stable_for_same_ctx() {
        let a = StatuslineCtx::minimal_for_test();
        let b = StatuslineCtx::minimal_for_test();
        assert_eq!(render_key(&a), render_key(&b));
    }

    #[test]
    fn render_key_changes_with_model_id() {
        let mut a = StatuslineCtx::minimal_for_test();
        a.payload.model.id = "a".into();
        let mut b = StatuslineCtx::minimal_for_test();
        b.payload.model.id = "b".into();
        assert_ne!(render_key(&a), render_key(&b));
    }

    #[test]
    fn render_key_ignores_cost_churn() {
        let mut a = StatuslineCtx::minimal_for_test();
        let mut b = StatuslineCtx::minimal_for_test();
        a.payload.cost.total_duration_ms = 1000;
        b.payload.cost.total_duration_ms = 999_999;
        assert_eq!(
            render_key(&a),
            render_key(&b),
            "cost ticks should not invalidate cache"
        );
    }

    #[test]
    fn input_round_trips_byte_identical_fresh() {
        let fixture = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config_corpus/statusline/input_fresh_session.json"
        ))
        .unwrap();
        let parsed: StatuslineInput = serde_json::from_str(&fixture).unwrap();
        let reemitted = serde_json::to_string_pretty(&parsed).unwrap();

        let reparsed: StatuslineInput = serde_json::from_str(&reemitted).unwrap();
        assert_eq!(parsed, reparsed);
        assert_eq!(parsed.model.id, "claude-opus-4-7");
        assert_eq!(parsed.workspace.added_dirs.len(), 0);
    }

    #[test]
    fn input_preserves_optional_blocks_mid_conversation() {
        let fixture = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config_corpus/statusline/input_mid_conversation.json"
        ))
        .unwrap();
        let parsed: StatuslineInput = serde_json::from_str(&fixture).unwrap();
        assert_eq!(parsed.session_name.as_deref(), Some("auth refactor"));
        assert_eq!(parsed.workspace.added_dirs.len(), 1);
        assert_eq!(parsed.cost.total_lines_added, 312);
    }

    #[test]
    fn input_over_200k_exceeds_flag_true() {
        let fixture = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config_corpus/statusline/input_over_200k.json"
        ))
        .unwrap();
        let parsed: StatuslineInput = serde_json::from_str(&fixture).unwrap();
        assert!(parsed.exceeds_200k_tokens);
        assert!(parsed.context_window.used_percentage >= 100);
    }

    #[test]
    fn input_yolo_structurally_identical_to_mid_conversation() {

        let fixture = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config_corpus/statusline/input_yolo_active.json"
        ))
        .unwrap();
        let parsed: StatuslineInput = serde_json::from_str(&fixture).unwrap();

        assert!(!parsed.extra.contains_key("permission_mode"));
        assert!(!parsed.extra.contains_key("permissionMode"));
        assert!(!parsed.extra.contains_key("otherside_permission_mode"));
    }

    #[test]
    fn statusline_cache_round_trip() {
        let mut cache = StatuslineCache::new();
        let ctx = StatuslineCtx::minimal_for_test();
        let key = render_key(&ctx);
        assert!(cache.get(key).is_none());
        cache.store(
            key,
            StatuslineLine {
                content: "hi".into(),
                width_cols: 2,
            },
        );
        assert_eq!(cache.get(key).unwrap().content, "hi");
        cache.invalidate();
        assert!(cache.get(key).is_none());
    }
}
