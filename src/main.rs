//! otherside CLI binary entry point.
//!
//! This file is deliberately thin: it sets up tracing, parses CLI args via
//! clap, and dispatches to the library. All real work lives in the library
//! crate (`lib.rs`) so integration tests can exercise it without shelling
//! out.
//!
//! # Exit code discipline
//!
//! Per `openspec/specs/cli/spec.md`, the CLI exits with:
//! - `10` — auth error (no credentials, refresh failed, 401)
//! - `20` — network error (connection refused, TLS failure)
//! - `30` — rate limit error (HTTP 429)
//! - `1`  — any other error
//!
//! `#[tokio::main]` hides a subtlety: if we return `Err(_)` from the
//! async main, anyhow prints the error and exits with code 1 — losing
//! the typed exit code. To preserve the mapping we run the dispatch in
//! an inner async function returning our typed [`Error`], catch it,
//! print to stderr ourselves, and call [`std::process::exit`] explicitly
//! with [`Error::exit_code`].

use std::io::{self, Write};
use std::net::{IpAddr, SocketAddr};
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use futures::StreamExt;

use otherside::auth;
use otherside::config;
use otherside::error::{Error, Result};
use otherside::inference::{OpenAiChatMessage, OpenAiChatRequest, OpenAiChatRole};
use otherside::provider::{anthropic::AnthropicProvider, codex::CodexProvider, Registry};
use otherside::serve;
use otherside::thinking::parse_suffix;
use otherside::tui;

/// otherside — multi-provider interactive coding agent.
#[derive(Parser, Debug)]
#[command(
    name = "otherside",
    version,
    about = "Multi-provider interactive coding agent",
    long_about = None,
)]
struct Cli {
    /// Non-interactive print mode. Sends the prompt once and streams the
    /// response to stdout.
    #[arg(short = 'p', long = "print")]
    print: Option<String>,

    /// Model override — `claude-opus-4-7` or with a thinking suffix,
    /// e.g. `claude-opus-4-7(xhigh)`.
    #[arg(long)]
    model: Option<String>,

    /// Provider override. Defaults to `default_provider` from
    /// `~/.otherside/settings.json`, else `anthropic-oauth`.
    #[arg(long)]
    provider: Option<String>,

    /// Enable verbose logging (INFO level).
    #[arg(long)]
    verbose: bool,

    /// Enable debug logging (DEBUG level). Overrides `--verbose`.
    #[arg(long)]
    debug: bool,

    /// Path to an alternative settings file. Defaults to
    /// `~/.otherside/settings.json`.
    #[arg(long)]
    config: Option<std::path::PathBuf>,

    /// Start the session in yolo permission mode — all tool calls
    /// auto-approve without prompting. Equivalent to setting
    /// `permissionMode = "yolo"` in `settings.json`, but scoped to
    /// this invocation only. The classic upstream spelling
    /// `--dangerously-skip-permissions` is accepted as an alias for
    /// migration ease.
    #[arg(long, alias = "dangerously-skip-permissions")]
    yolo: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(clap::Subcommand, Debug)]
enum Command {
    /// Run OAuth login flow for a provider. Only `anthropic-oauth` is
    /// implemented in MVP.
    Login {
        /// Provider to log in to.
        #[arg(long)]
        provider: String,
    },
    /// Clear cached credentials for a provider.
    Logout {
        /// Provider to clear.
        #[arg(long)]
        provider: String,
    },
    /// Run an OpenAI-compatible local HTTP server. Point Cursor / Cline /
    /// aider / Continue at `http://<host>:<port>/v1` with any dummy API
    /// key — requests ride the configured provider's OAuth session.
    Serve {
        /// Interface to bind. Default `127.0.0.1` — no auth is applied on
        /// loopback, so binding externally exposes the proxy to anyone on
        /// the network.
        #[arg(long, default_value = "127.0.0.1")]
        host: IpAddr,

        /// TCP port. `0` selects an ephemeral port — the actual bind
        /// address is printed to stdout.
        #[arg(long, default_value_t = 8080)]
        port: u16,
    },
    /// Interactive chat TUI. Multi-turn conversation with the configured
    /// provider. In-memory only — history doesn't persist yet. Also the
    /// default when the binary is invoked with no subcommand and no `-p`.
    Tui,
}

/// Baked-in MVP defaults. When config + CLI flags don't override, we
/// fall back to these.
const DEFAULT_PROVIDER: &str = "anthropic-oauth";
const DEFAULT_MODEL: &str = "claude-opus-4-7";

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    setup_tracing(&cli);

    // Subagent runner install happens lazily — once `run()` resolves
    // the provider + model we know enough to wire `InnerLoopRunner`.
    // See `otherside::run` for the call site.

    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("otherside: {err}");
            ExitCode::from(err.exit_code() as u8)
        }
    }
}

/// Configure the global tracing subscriber based on `--verbose` /
/// `--debug` / `RUST_LOG`. `RUST_LOG` always wins for power users.
fn setup_tracing(cli: &Cli) {
    let default_level = if cli.debug {
        "debug"
    } else if cli.verbose {
        "info"
    } else {
        "warn"
    };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_level));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr)
        .init();
}

/// Top-level dispatch. Thin — every non-trivial branch delegates to a
/// dedicated function so `run` itself remains obvious to read.
async fn run(cli: Cli) -> Result<()> {
    // Best-effort backfill: cached creds from legacy refreshes lack
    // `subscription_type` / `rate_limit_tier`. Upstream hydrates these
    // from `GET /api/oauth/profile` on every refresh; we do the same
    // once per invocation so the tier-aware defaults (opus[1m] gating,
    // /model picker opus row) see the real plan. Silent no-op on
    // endpoint error or already-hydrated creds.
    if let Err(e) = otherside::auth::anthropic::hydrate_subscription_if_missing().await {
        tracing::warn!(?e, "subscription hydrate failed (non-fatal)");
    }

    match &cli.command {
        Some(Command::Login { provider }) => cmd_login(provider).await,
        Some(Command::Logout { provider }) => cmd_logout(provider),
        Some(Command::Serve { host, port }) => cmd_serve(&cli, *host, *port).await,
        Some(Command::Tui) => cmd_tui(&cli).await,
        None => {
            if let Some(prompt) = &cli.print {
                cmd_print(&cli, prompt).await
            } else {
                // Bare `otherside` — launch the TUI. That's the more
                // intuitive default now that we have one; `-p` remains
                // the explicit non-interactive escape hatch and
                // `tui` is a belt-and-braces explicit subcommand.
                cmd_tui(&cli).await
            }
        }
    }
}

/// `otherside login --provider <id>` — drive the OAuth flow.
async fn cmd_login(provider: &str) -> Result<()> {
    match provider {
        "anthropic-oauth" => {
            let creds = auth::anthropic::login_interactive().await?;
            // Report non-sensitive summary — never print the bearer.
            // Scopes + expiry help a user confirm the flow succeeded.
            println!("\nLogged in to anthropic-oauth.");
            println!("  scopes: {}", creds.scopes.join(", "));
            println!("  expires_at (epoch ms): {}", creds.expires_at);
            Ok(())
        }
        "codex" => {
            let creds = auth::codex::login_interactive().await?;
            println!("\nLogged in to codex (ChatGPT OAuth).");
            if let Some(acct) = creds.account_id.as_ref() {
                println!("  account_id: {acct}");
            }
            println!("  scopes: {}", creds.scopes.join(", "));
            println!("  expires_at (epoch ms): {}", creds.expires_at);
            Ok(())
        }
        other => Err(Error::Other(format!(
            "provider {other:?} has no login flow — try `anthropic-oauth` or `codex`"
        ))),
    }
}

/// `otherside logout --provider <id>` — clear persisted credentials.
fn cmd_logout(provider: &str) -> Result<()> {
    match provider {
        "anthropic-oauth" => {
            auth::anthropic::clear_credentials()?;
            println!("Cleared cached credentials for anthropic-oauth.");
            Ok(())
        }
        "codex" => {
            auth::codex::clear_credentials()?;
            println!("Cleared cached credentials for codex.");
            Ok(())
        }
        other => Err(Error::Other(format!(
            "provider {other:?} not known"
        ))),
    }
}

/// `otherside -p "<prompt>"` — the MVP's raison d'être. Build a
/// one-shot request, stream the response, write content deltas to
/// stdout in real time.
async fn cmd_print(cli: &Cli, prompt: &str) -> Result<()> {
    // Resolve config, provider, model with clean precedence:
    //   CLI flag > env (applied inside config::load*) > settings file
    //   > hard-coded default.
    let settings = match &cli.config {
        Some(path) => config::load_from(path)?,
        None => config::load()?,
    };

    let provider_id = cli
        .provider
        .clone()
        .or(settings.default_provider.clone())
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());

    let raw_model = cli
        .model
        .clone()
        .or(settings.default_model.clone())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    // Split a `(suffix)` thinking tag off the model name so what goes
    // on the wire is the bare model id — matches captured fingerprint.
    // The parsed ThinkingConfig rides the stream call alongside the
    // request per C12 (suffix > body params).
    let (base_model, thinking) = parse_suffix(&raw_model)
        .map_err(|e| Error::Other(format!("invalid model suffix: {e}")))?;

    tracing::debug!(
        provider = %provider_id,
        model = %base_model,
        has_thinking = thinking.is_some(),
        "resolved dispatch"
    );

    // Build the canonical OpenAI-shaped request. Single user message
    // for MVP; interactive mode will extend to multi-turn.
    let req = OpenAiChatRequest {
        model: base_model,
        messages: vec![OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: prompt.to_string(),
            name: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
        }],
        stream: Some(true),
        max_tokens: None,
        temperature: None,
        top_p: None,
        stop: None,
        tools: Vec::new(),
        tool_choice: None,
        extra: serde_json::Map::new(),
    };

    // Build the provider registry. For MVP only anthropic-oauth is
    // wired; other providers produce a clear error up front.
    let registry = Registry::builder()
        .with(AnthropicProvider::arc()?)
        .with(CodexProvider::arc()?)
        .build();
    let provider = registry.get(&provider_id).ok_or_else(|| {
        Error::Other(format!(
            "provider {provider_id:?} not registered (MVP supports: anthropic-oauth)"
        ))
    })?;

    // Stream and print. Flush on every chunk so streaming actually
    // feels streamed — without flush, stdout buffers into ~4KB blocks
    // and the user sees the whole response materialize at once.
    let mut stream = provider.stream(req, thinking).await?;
    let mut stdout = io::stdout().lock();
    let mut any_content = false;
    while let Some(item) = stream.next().await {
        let chunk = item?;
        let Some(choice) = chunk.choices.into_iter().next() else {
            continue;
        };
        if let Some(content) = choice.delta.content {
            if !content.is_empty() {
                any_content = true;
                stdout
                    .write_all(content.as_bytes())
                    .map_err(|e| Error::Other(format!("stdout write: {e}")))?;
                stdout
                    .flush()
                    .map_err(|e| Error::Other(format!("stdout flush: {e}")))?;
            }
        }
        // finish_reason rides the last chunk — nothing to print; we
        // just drain until the stream ends.
    }
    // Trailing newline so shell prompts land on the next line, but
    // only if we actually printed anything (avoid a blank line on
    // empty responses).
    if any_content {
        writeln!(stdout).ok();
    }
    Ok(())
}

/// `otherside serve` — boot the OpenAI-compatible HTTP proxy.
///
/// Shares config resolution with `cmd_print` so both entrypoints pick the
/// same default provider. The server runs until the process receives Ctrl-C;
/// the spec's 30s graceful shutdown window is deferred to a follow-up
/// change (we rely on axum's default close-on-signal for MVP).
async fn cmd_serve(cli: &Cli, host: IpAddr, port: u16) -> Result<()> {
    let settings = match &cli.config {
        Some(path) => config::load_from(path)?,
        None => config::load()?,
    };

    let provider_id = cli
        .provider
        .clone()
        .or(settings.default_provider.clone())
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());

    // Build the same registry `cmd_print` uses — the serve path doesn't
    // duplicate provider wiring, it reuses it. MVP carries only
    // `anthropic-oauth`; adding providers here automatically exposes them
    // to both CLI paths.
    let registry = Registry::builder()
        .with(AnthropicProvider::arc()?)
        .with(CodexProvider::arc()?)
        .build();

    if registry.get(&provider_id).is_none() {
        return Err(Error::Other(format!(
            "provider {provider_id:?} not registered (MVP supports: anthropic-oauth)"
        )));
    }

    let registry = Arc::new(registry);
    let bind = SocketAddr::from((host, port));
    serve::run(bind, registry, provider_id).await
}

/// `otherside tui` (and bare `otherside`) — boot the interactive chat TUI.
///
/// Shares config resolution with `cmd_print` / `cmd_serve` so the same
/// precedence rules apply. The raw model string (with any thinking suffix
/// like `(xhigh)`) is passed through; the TUI module parses the suffix
/// once at startup so every turn reuses the parsed `ThinkingConfig`.
async fn cmd_tui(cli: &Cli) -> Result<()> {
    let settings = match &cli.config {
        Some(path) => config::load_from(path)?,
        None => config::load()?,
    };

    let provider_id = cli
        .provider
        .clone()
        .or(settings.default_provider.clone())
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());

    // Tier-aware default: when the user has no CLI `--model` override
    // and no persisted `settings.default_model`, derive the default
    // from the OAuth subscription tier. Max / Team Premium / Ant
    // internal → opus[1m]; everyone else → sonnet. Mirrors upstream
    // `getDefaultMainLoopModelSetting`.
    let tier_default = {
        use otherside::models::defaults::{default_claude_code_for_tier, SubscriptionTier};
        let tier_str = otherside::auth::anthropic::load_credentials()
            .ok()
            .flatten()
            .and_then(|c| c.subscription_type.clone());
        let tier = SubscriptionTier::from_subscription_type(tier_str.as_deref());
        default_claude_code_for_tier(tier).to_string()
    };
    let raw_model = cli
        .model
        .clone()
        .or(settings.default_model.clone())
        .unwrap_or(tier_default);

    let registry = Registry::builder()
        .with(AnthropicProvider::arc()?)
        .with(CodexProvider::arc()?)
        .build();

    if registry.get(&provider_id).is_none() {
        return Err(Error::Other(format!(
            "provider {provider_id:?} not registered (MVP supports: anthropic-oauth)"
        )));
    }

    let registry = Arc::new(registry);

    // Wire the subagent runner now that the provider is resolved. The
    // runner spawns an inner AgentLoop against the same provider, so
    // it must know which one was picked + what model to default to.
    // OnceLock semantics: first install wins — re-entry is a no-op so
    // --resume / multi-subcommand flows don't double-install.
    if let Some(provider) = registry.get(&provider_id) {
        let _ = otherside::subagents::install_runner(
            otherside::subagents::InnerLoopRunner::new(
                provider.clone(),
                raw_model.clone(),
            ),
        );
    }

    // Session-start mode:
    // - `--yolo` flag → Yolo
    // - otherwise → AcceptEdits (the visible "default" in the cycle).
    //   The `Default` (ask-before-edit) mode is hidden from the TUI
    //   cycle and never becomes the session-start value. Permission
    //   mode is session-scoped — NOT loaded from settings.json.
    let permission_mode = if cli.yolo {
        config::PermissionMode::Yolo
    } else {
        config::PermissionMode::AcceptEdits
    };
    tui::run(registry, raw_model, provider_id, permission_mode, settings).await
}
