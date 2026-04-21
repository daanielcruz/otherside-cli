

pub const CLAUDE_CODE_VERSION: &str = "2.1.113";

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

pub const OAUTH_AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
pub const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const OAUTH_REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";
pub const OAUTH_HELLO_URL: &str = "https://platform.claude.com/v1/oauth/hello";

pub const API_HELLO_URL: &str = "https://api.anthropic.com/api/hello";
pub const API_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages?beta=true";
pub const API_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
pub const API_ROLES_URL: &str = "https://api.anthropic.com/api/oauth/claude_cli/roles";
pub const API_FIRST_TOKEN_DATE_URL: &str =
    "https://api.anthropic.com/api/organization/claude_code_first_token_date";
pub const API_MCP_SERVERS_URL: &str = "https://api.anthropic.com/v1/mcp_servers?limit=1000";

pub const LOGIN_SCOPES: &[&str] = &[
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

pub const REFRESH_SCOPES: &[&str] = &[
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

pub fn ua_cli() -> String {
    format!("claude-cli/{CLAUDE_CODE_VERSION} (external, cli)")
}

pub fn ua_sdk_cli() -> String {
    format!("claude-cli/{CLAUDE_CODE_VERSION} (external, sdk-cli)")
}

pub const UA_AXIOS: &str = "axios/1.13.6";

pub fn ua_short() -> String {
    format!("claude-code/{CLAUDE_CODE_VERSION}")
}

pub const STAINLESS_LANG: &str = "js";
pub const STAINLESS_PACKAGE_VERSION: &str = "0.81.0";
pub const STAINLESS_RUNTIME: &str = "node";
pub const STAINLESS_RUNTIME_VERSION: &str = "v24.3.0";
pub const STAINLESS_TIMEOUT: &str = "600";

pub const ANTHROPIC_BETA_INFERENCE: &str =
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24";

pub const ANTHROPIC_BETA_CONTEXT_1M: &str = "context-1m-2025-08-07";

pub const ANTHROPIC_BETA_WEB_SEARCH: &str =
    "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24";

pub const ANTHROPIC_BETA_MCP_SERVERS: &str = "mcp-servers-2025-12-04";

pub const ANTHROPIC_BETA_OAUTH: &str = "oauth-2025-04-20";

pub const ANTHROPIC_VERSION: &str = "2023-06-01";

pub const BILLING_HEADER_TEXT: &str =
    "x-anthropic-billing-header: cc_version=2.1.113.9c8; cc_entrypoint=sdk-cli; cch=1826d;";

pub fn stainless_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    }
}

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
