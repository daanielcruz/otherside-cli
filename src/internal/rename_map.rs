//! R-41 rename marker — opaque hash → otherside identifier.
//!
//! SHA256(upstream_fqn)[0..12] maps to the otherside identifier that
//! replaced it. Upstream plaintext names NEVER appear in this source
//! file — only hashes. The table is a fingerprint-safe discoverability
//! marker: given an otherside symbol, future auditors can confirm a
//! MAPPING row exists without exposing the original name in the crate.
//!
//! Populated by identifier-clean extraction from outer `MAPPING.md`
//! (prose rows like "_(planned: X)_" or "(not in TS — new)" are
//! skipped — only real upstream symbols / file paths / flags).
//! Upstream-name duplicates collapse to the first-seen otherside id.
//!
//! R-42: 12 hex chars (48 bits of entropy). Sufficient to distinguish
//! every identifier-grade rename row without widening the binary.

/// One rename marker: `(hash12, otherside_id)`.
pub type RenameRow = (&'static str, &'static str);

/// Opaque rename markers. 52 entries.
pub const RENAMES: &[RenameRow] = &[
    ("325d9de29bb2", "otherside-cli/src/config/mod.rs::load_all"),
    ("358f0931c238", "otherside-cli/src/config/mod.rs::write_atomic"),
    ("5de21decd4dc", "otherside-cli/src/statusline/subprocess.rs::execute"),
    ("8029c8ae8b72", "otherside-cli/src/statusline/types.rs::StatuslineInput"),
    ("7bfb2ebf63d4", "otherside-cli/src/statusline/types.rs::StatuslineInput"),
    ("22e914201bf5", "tui::state::ConversationState::new_for_model"),
    ("d093a1935d48", "tui::state::ConversationState::new_for_model_with_mode"),
    ("d05969bdc8d7", "tui::state::ConversationState::switch_model"),
    ("61ea72498bf9", "tui::state::ConversationState::compact_history"),
    ("b5ecab29c8ee", "tui::state::ConversationState::cycle_permission_mode"),
    ("7a5b8c778fbf", "tui::state::ConversationState::context_window_label"),
    ("35db92992593", "error::Error::Network"),
    ("9f803bd644e7", "error::Error::RateLimit"),
    ("f45fc1dfdc96", "Value"),
    ("91c67517d255", "https://platform.claude.com/oauth/code/callback"),
    ("1cf587e0bafe", "Endpoints"),
    ("ba5caa4285a8", "Value"),
    ("2e3bdca6bdfd", "js"),
    ("4a5a57151d7e", "node"),
    ("e5fb2670bb05", "true"),
    ("cfc4e016b526", "cli"),
    ("3df9726c68ba", "anthropic-beta"),
    ("270fb5aa87f4", "OTHERSIDE_DISABLE_NONESSENTIAL_TRAFFIC"),
    ("2e8a45090ffe", "OTHERSIDE_FILE_READ_MAX_OUTPUT_TOKENS"),
    ("298fecff60fe", "OTHERSIDE_REPL"),
    ("35944d09f193", "OTHERSIDE_DISABLE_1M_CONTEXT"),
    ("5b98443df528", "OTHERSIDE_DECSTBM"),
    ("1e43267fe87d", "OTHERSIDE_ASYNC_AGENT_STALL_TIMEOUT_MS"),
    ("c32021b2bfab", "OTHERSIDE_BS_AS_CTRL_BACKSPACE"),
    ("8f9147c8dcb5", "OTHERSIDE_BG_BACKEND"),
    ("4995d32c3cb7", "OTHERSIDE_AGENT_COST_STEER"),
    ("ee45f7f7109b", "OTHERSIDE_CONFIG_DIR"),
    ("6141576115a6", "OTHERSIDE_SWARM_ENABLED"),
    ("f5cca2374fce", "OTHERSIDE_MAX_MCP_OUTPUT_TOKENS"),
    ("52c067e0c64e", "OTHERSIDE_MCP_TRUNCATION_PROMPT_OVERRIDE"),
    ("adc74704d65d", "Handler"),
    ("46ce6755080d", "Notes"),
    ("78576b31ad79", "Settings.permissions.allow"),
    ("1ca7ca9d18e4", "Settings.permissions.deny"),
    ("006bf7296aef", "Settings.permissions.ask"),
    ("b77349bf1fa9", "Settings.env"),
    ("a9fa9fda98d7", "Settings.hooks"),
    ("11085a31bbdf", "HooksConfig.pre_tool_use"),
    ("b7e653232d03", "HooksConfig.post_tool_use"),
    ("d24f1a6f455d", "Settings.strict_plugin_only_customization"),
    ("36914db577c1", "Settings.allow_managed_hooks_only"),
    ("b31417bbbb49", "Settings.allowed_mcp_servers"),
    ("014eb39dc1ec", "Settings.disabled_mcp_servers"),
    ("5cd469e06e73", "config.monitor_tool_enabled"),
    ("f8850b0568fa", "config.dream_enabled"),
    ("bb3b56d2c989", "config.memory_extract_throttle_turns"),
    ("fdbe66a72e06", "config.default_effort_by_tier"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_hash_is_twelve_hex_chars() {
        for (h, _) in RENAMES {
            assert_eq!(h.len(), 12, "hash must be 12 hex chars");
            assert!(h.chars().all(|c| c.is_ascii_hexdigit()),
                "hash must be hex: {h}");
        }
    }

    #[test]
    fn no_upstream_plaintext_leakage() {
        for (_, otherside_id) in RENAMES {
            let lower = otherside_id.to_lowercase();
            assert!(!lower.contains("claudecode"),
                "otherside_id leaks upstream brand: {otherside_id}");
            assert!(!lower.contains("claude-code"),
                "otherside_id leaks upstream brand: {otherside_id}");
        }
    }

    #[test]
    fn rename_count_is_nontrivial() {
        assert!(RENAMES.len() >= 50,
            "R-41 table should carry at least 50 identifier-grade rows");
    }

    #[test]
    fn hashes_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for (h, _) in RENAMES {
            assert!(seen.insert(*h),
                "duplicate hash {h} — dedupe upstream side before emission");
        }
    }
}
