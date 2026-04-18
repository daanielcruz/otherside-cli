//! Authentication flows per provider.
//!
//! # Model
//!
//! Each provider backend has its own auth strategy:
//!
//! - `anthropic-oauth` — OAuth 2.0 authorization-code + PKCE, piggybacking on
//!   Claude Code's `client_id` (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`).
//!   Token exchange at `https://platform.claude.com/v1/oauth/token`.
//! - `codex` — ChatGPT OAuth piggyback (future capture session).
//! - `gemini-cli` — Google OAuth piggyback (future capture session).
//! - `openai-compatible` — user-supplied URL + API key, no OAuth flow.
//!
//! # Credential storage (C4)
//!
//! All token sets live in `~/.otherside/credentials.json` keyed by provider
//! ID. Plain JSON, no keychain integration in MVP (see P3 for parked
//! revisit).
//!
//! # Refresh behavior (captured 2026-04-17 — see `fingerprint_corpus/oauth/refresh_behavior.md`)
//!
//! Claude Code does refresh PROACTIVELY based on local `expires_at`
//! comparison, not reactively on HTTP 401. otherside matches this behavior
//! per D6 (impersonation rule). On 401, the CLI exits with auth error
//! code 10 and tells the user to re-login.
//!
//! # Fingerprint
//!
//! The token exchange request uses `User-Agent: axios/1.13.6` and a specific
//! header set — the `fingerprint` module owns these values.
//!
//! # Modules
//!
//! - `anthropic` — Anthropic OAuth flow (MVP).
//! - `codex` — ChatGPT OAuth flow (post-MVP).
//! - `gemini` — Google OAuth flow (post-MVP).

pub mod anthropic;
pub mod pkce;
