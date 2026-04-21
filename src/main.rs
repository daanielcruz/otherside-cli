

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

#[derive(Parser, Debug)]
#[command(
    name = "otherside",
    version,
    about = "Multi-provider interactive coding agent",
    long_about = None,
)]
struct Cli {

    #[arg(short = 'p', long = "print")]
    print: Option<String>,

    #[arg(long)]
    model: Option<String>,

    #[arg(long)]
    provider: Option<String>,

    #[arg(long)]
    verbose: bool,

    #[arg(long)]
    debug: bool,

    #[arg(long)]
    config: Option<std::path::PathBuf>,

    #[arg(long, alias = "dangerously-skip-permissions")]
    yolo: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(clap::Subcommand, Debug)]
enum Command {

    Login {

        #[arg(long)]
        provider: String,
    },

    Logout {

        #[arg(long)]
        provider: String,
    },

    Serve {

        #[arg(long, default_value = "127.0.0.1")]
        host: IpAddr,

        #[arg(long, default_value_t = 8080)]
        port: u16,
    },

    Tui,
}

const DEFAULT_PROVIDER: &str = "anthropic-oauth";
const DEFAULT_MODEL: &str = "claude-opus-4-7";

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    setup_tracing(&cli);

    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("otherside: {err}");
            ExitCode::from(err.exit_code() as u8)
        }
    }
}

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

async fn run(cli: Cli) -> Result<()> {

    if let Err(e) = otherside::state::PersistenceState::hydrate_subscription_on_boot().await {
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

                cmd_tui(&cli).await
            }
        }
    }
}

async fn cmd_login(provider: &str) -> Result<()> {
    use config::providers::ProviderId;
    let id = ProviderId::from_slug(provider).ok_or_else(|| {
        Error::Other(format!("provider {provider:?} is not a known id"))
    })?;
    match id {
        ProviderId::ClaudeCode => {
            let creds = auth::anthropic::login_interactive().await?;

            println!("\nLogged in to {}.", id.slug());
            println!("  scopes: {}", creds.scopes.join(", "));
            println!("  expires_at (epoch ms): {}", creds.expires_at);
            Ok(())
        }
        ProviderId::Codex => {
            let creds = auth::codex::login_interactive().await?;
            println!("\nLogged in to codex (ChatGPT OAuth).");
            if let Some(acct) = creds.account_id.as_ref() {
                println!("  account_id: {acct}");
            }
            println!("  scopes: {}", creds.scopes.join(", "));
            println!("  expires_at (epoch ms): {}", creds.expires_at);
            Ok(())
        }
        ProviderId::GeminiCli | ProviderId::OpenAiCustom => Err(Error::Other(format!(
            "provider {provider:?} has no login flow — try `anthropic-oauth` or `codex`"
        ))),
    }
}

fn cmd_logout(provider: &str) -> Result<()> {
    use config::providers::ProviderId;
    let id = ProviderId::from_slug(provider).ok_or_else(|| {
        Error::Other(format!("provider {provider:?} not known"))
    })?;
    match id {
        ProviderId::ClaudeCode => {
            auth::anthropic::clear_credentials()?;
            println!("Cleared cached credentials for {}.", id.slug());
            Ok(())
        }
        ProviderId::Codex => {
            auth::codex::clear_credentials()?;
            println!("Cleared cached credentials for codex.");
            Ok(())
        }
        ProviderId::GeminiCli | ProviderId::OpenAiCustom => Err(Error::Other(format!(
            "provider {provider:?} has no credential store to clear"
        ))),
    }
}

async fn cmd_print(cli: &Cli, prompt: &str) -> Result<()> {

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

    let (base_model, thinking) = parse_suffix(&raw_model)
        .map_err(|e| Error::Other(format!("invalid model suffix: {e}")))?;

    tracing::debug!(
        provider = %provider_id,
        model = %base_model,
        has_thinking = thinking.is_some(),
        "resolved dispatch"
    );

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

    let registry = Registry::builder()
        .with(AnthropicProvider::arc()?)
        .with(CodexProvider::arc()?)
        .build();
    let provider = registry.get(&provider_id).ok_or_else(|| {
        Error::Other(format!(
            "provider {provider_id:?} not registered (MVP supports: anthropic-oauth)"
        ))
    })?;

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

    }

    if any_content {
        writeln!(stdout).ok();
    }
    Ok(())
}

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

    if let Some(provider) = registry.get(&provider_id) {
        let _ = otherside::subagents::install_runner(
            otherside::subagents::InnerLoopRunner::new(
                provider.clone(),
                raw_model.clone(),
            ),
        );
    }

    let permission_mode = if cli.yolo {
        config::PermissionMode::Yolo
    } else {
        config::PermissionMode::AcceptEdits
    };
    tui::run(registry, raw_model, provider_id, permission_mode, settings).await
}
