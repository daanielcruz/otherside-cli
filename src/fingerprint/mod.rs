//! HTTP fingerprint profiles per provider.
//!
//! This is the ONE module in the crate that cares about "which upstream CLI
//! are we pretending to be". All other modules just ask the fingerprint
//! registry: "give me the headers for an anthropic inference request" and
//! don't think about it further.
//!
//! # Impersonation rule (D6 + memory `project_otherside_fingerprint_impersonation`)
//!
//! Every outbound HTTP request to a provider endpoint MUST go through a
//! fingerprint profile. The profile:
//!
//! - Sets the exact `User-Agent` string
//! - Includes every captured "impersonation" header (X-Stainless-*,
//!   anthropic-beta, x-app, etc.)
//! - Embeds any in-body fingerprint markers (billing header in system[0])
//! - Honors captured versioning (anthropic-version, SDK package version)
//!
//! The `reqwest` default User-Agent MUST NEVER leak.
//!
//! # Per-endpoint surfaces
//!
//! Claude Code uses four distinct UAs. The fingerprint submodule per
//! provider groups them:
//!
//! | UA | Endpoints |
//! |---|---|
//! | `claude-cli/<ver> (external, cli)` | `/api/hello`, `/v1/oauth/hello` |
//! | `claude-cli/<ver> (external, sdk-cli)` | `/v1/messages` |
//! | `axios/<ver>` | `/v1/oauth/token`, `/api/oauth/profile`, `/api/oauth/claude_cli/roles`, `/v1/mcp_servers` |
//! | `claude-code/<ver>` | `/api/organization/claude_code_first_token_date` |
//!
//! # In-body fingerprint (C33)
//!
//! The Anthropic inference endpoint receives a billing header embedded in
//! `system[0]` of the request body: `cc_version=<hash>; cc_entrypoint=sdk-cli; cch=<hash>`.
//! This is hardcoded from the latest capture session and bumped when a new
//! capture updates it.

pub mod anthropic;
