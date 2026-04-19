//! Anthropic (Claude Code 2.1.113) fingerprint profile.
//!
//! All values here are captured verbatim from a real Claude Code 2.1.113
//! session (2026-04-17). When a new capture session updates these, bump the
//! constants AND note the new Claude Code version in the version-tag constant.

/// The Claude Code version we are impersonating. Bumped when a new capture
/// session updates the fingerprint constants.
pub const CLAUDE_CODE_VERSION: &str = "2.1.113";

/// OAuth production client_id (shared across all fingerprint surfaces).
/// Source: `reconstructed/2.1.113/source/constants/oauth.ts` PROD_OAUTH_CONFIG.
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// OAuth endpoints (platform.claude.com, NOT api.anthropic.com).
pub const OAUTH_AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
pub const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const OAUTH_REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";
pub const OAUTH_HELLO_URL: &str = "https://platform.claude.com/v1/oauth/hello";

/// API endpoints (api.anthropic.com).
pub const API_HELLO_URL: &str = "https://api.anthropic.com/api/hello";
pub const API_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages?beta=true";
pub const API_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
pub const API_ROLES_URL: &str = "https://api.anthropic.com/api/oauth/claude_cli/roles";
pub const API_FIRST_TOKEN_DATE_URL: &str =
    "https://api.anthropic.com/api/organization/claude_code_first_token_date";
pub const API_MCP_SERVERS_URL: &str = "https://api.anthropic.com/v1/mcp_servers?limit=1000";

/// OAuth scope lists (request body form, not URL form — URL form is plus-joined).
pub const LOGIN_SCOPES: &[&str] = &[
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];
/// Refresh drops `org:create_api_key` — captured behavior.
pub const REFRESH_SCOPES: &[&str] = &[
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

// =============================================================================
// User-Agent strings (4 distinct surfaces — see module docs).
// =============================================================================

/// `claude-cli/<ver> (external, cli)` — used by /api/hello + /v1/oauth/hello.
pub fn ua_cli() -> String {
    format!("claude-cli/{CLAUDE_CODE_VERSION} (external, cli)")
}

/// `claude-cli/<ver> (external, sdk-cli)` — used by /v1/messages inference.
pub fn ua_sdk_cli() -> String {
    format!("claude-cli/{CLAUDE_CODE_VERSION} (external, sdk-cli)")
}

/// `axios/1.13.6` — used by /v1/oauth/token, /api/oauth/profile, /api/oauth/claude_cli/roles,
/// /v1/mcp_servers. Exactly the axios default UA.
pub const UA_AXIOS: &str = "axios/1.13.6";

/// `claude-code/<ver>` — used by /api/organization/claude_code_first_token_date.
pub fn ua_short() -> String {
    format!("claude-code/{CLAUDE_CODE_VERSION}")
}

// =============================================================================
// Stainless SDK fingerprint headers (for /v1/messages only).
// =============================================================================

pub const STAINLESS_LANG: &str = "js";
pub const STAINLESS_PACKAGE_VERSION: &str = "0.81.0";
pub const STAINLESS_RUNTIME: &str = "node";
pub const STAINLESS_RUNTIME_VERSION: &str = "v24.3.0";
pub const STAINLESS_TIMEOUT: &str = "600";

// =============================================================================
// anthropic-beta header values (vary per endpoint).
// =============================================================================

/// 7 beta flags for /v1/messages inference — captured 2026-04-17.
pub const ANTHROPIC_BETA_INFERENCE: &str =
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24";

/// 1M context window beta flag — appended to `anthropic-beta` when the
/// model alias carries a `[1m]` suffix. Literal byte-matches upstream's
/// `CONTEXT_1M_BETA_HEADER` (constants/betas.ts) so Max / Team Premium
/// subscribers see the full 1M window.
pub const ANTHROPIC_BETA_CONTEXT_1M: &str = "context-1m-2025-08-07";

/// 8-flag beta set upstream ships when invoking the `web_search_20250305`
/// server tool. Captured 2026-04-19 via Proxyman; see
/// `../../fingerprint_corpus/tools-websearch-single/notes.md`.
///
/// Differs from `ANTHROPIC_BETA_INFERENCE`: drops `advanced-tool-use-
/// 2025-11-20`, always includes `context-1m-2025-08-07` (not conditional),
/// and adds `redact-thinking-2026-02-12`. Sending the wrong set triggers
/// a 429 rate-limit rejection (Anthropic treats the caller as a non-CC
/// client when the fingerprint drifts).
pub const ANTHROPIC_BETA_WEB_SEARCH: &str =
    "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24";

/// Single flag for /v1/mcp_servers.
pub const ANTHROPIC_BETA_MCP_SERVERS: &str = "mcp-servers-2025-12-04";

/// Single flag for /api/organization/claude_code_first_token_date.
pub const ANTHROPIC_BETA_OAUTH: &str = "oauth-2025-04-20";

/// Anthropic API version header.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

// =============================================================================
// Billing header (C33) — embedded in request body system[0].
// =============================================================================

/// The literal text of the billing marker system block. Bumps with version.
pub const BILLING_HEADER_TEXT: &str =
    "x-anthropic-billing-header: cc_version=2.1.113.9c8; cc_entrypoint=sdk-cli; cch=1826d;";

// =============================================================================
// Platform detection for X-Stainless-Arch / X-Stainless-OS.
// =============================================================================
//
// Stainless SDK stamps these headers at runtime based on the host. Claude
// Code, running on node-darwin-arm64, sends `arm64` + `MacOS`. We compute
// the same values from the Rust host so our fingerprint matches the
// running platform rather than hard-coding a lie.

/// Map `std::env::consts::ARCH` to the string the Stainless SDK would emit.
pub fn stainless_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    }
}

/// Map `std::env::consts::OS` to the Stainless OS string.
pub fn stainless_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "MacOS",
        "linux" => "Linux",
        "windows" => "Windows",
        "freebsd" => "FreeBSD",
        "openbsd" => "OpenBSD",
        "netbsd" => "NetBSD",
        other => other,
    }
}
