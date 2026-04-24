
use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste,
    Event as CtEvent, EventStream, KeyCode, KeyEvent,
    KeyEventKind, KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::provider::{Provider, Registry};
use crate::thinking::{parse_suffix, ThinkingConfig};

mod agent_bridge;
pub mod autocomplete;
pub mod diff;
pub mod layout;
pub mod markdown;
pub mod mascot;
pub mod menu;
pub mod panel_frame;
pub mod progress;
pub mod render;
pub mod slash;
pub mod state;
pub mod tips;
pub mod todos;
pub mod tool_render;
pub mod welcome;

use state::{ConversationState, DisplayOrigin};

#[derive(Debug)]
enum StreamEvent {

    Delta(String),

    Done,

    Error(String),

    ToolCallStart {
        id: String,
        name: String,
        args: serde_json::Value,
    },

    ToolCallFinish {
        id: String,
        result: std::result::Result<serde_json::Value, String>,
        elapsed_ms: u64,
    },

    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },

    PermissionAsk {
        tool_name: String,
        args_preview: String,
        rule: Option<String>,
        reply: tokio::sync::oneshot::Sender<crate::permissions::PermissionResponse>,
    },

    AskUserQuestion {
        question: String,
        hint: Option<String>,
        reply: tokio::sync::oneshot::Sender<String>,
    },

    NestedToolStart {
        name: String,
        args: serde_json::Value,
    },

    NestedToolFinish {
        success: bool,
    },

    NestedUsage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },

    BackgroundAgentCompleted,

    CompactDone {
        summary: String,
        is_auto: bool,
    },

    CompactFailed {
        message: String,
    },
}

#[derive(Debug, Clone, Default)]
pub enum ResumeIntent {
    #[default]
    None,
    Latest,
    Specific(String),
    Picker,
}

pub async fn run(
    registry: Arc<Registry>,
    raw_model: String,
    provider_id: String,
    initial_permission_mode: crate::config::PermissionMode,
    settings: crate::config::settings::Settings,
    resume_intent: ResumeIntent,
) -> Result<()> {
    let _ = registry
        .get(&provider_id)
        .ok_or_else(|| Error::Other(format!("provider {provider_id:?} not registered")))?;

    let mut initial_provider =
        crate::config::providers::ProviderId::from_slug(&provider_id)
            .ok_or_else(|| Error::Other(format!("provider {provider_id:?} not recognized")))?;

    let (mut base_model, thinking) = parse_suffix(&raw_model)
        .map_err(|e| Error::Other(format!("invalid model suffix: {e}")))?;

    let mut settings = settings;

    let mut guard = TerminalGuard::enter()?;

    let mut welcome_just_completed = false;
    if !crate::state::broker::has_any_credentials(&settings) {
        use crate::config::providers::ProviderId;
        'welcome: loop {
            match run_welcome_gate(&mut guard.terminal).await? {
                WelcomeGateOutcome::Proceed(provider) => {
                    match provider {
                        ProviderId::ClaudeCode => {
                            let mut handshake =
                                match crate::auth::anthropic::begin_login() {
                                    Ok(h) => h,
                                    Err(_) => continue 'welcome,
                                };
                            let automatic_url = handshake.automatic_url().to_string();
                            let manual_url = handshake.manual_url().to_string();
                            let port = handshake.port();
                            let listener = match handshake.take_listener() {
                                Some(l) => l,
                                None => continue 'welcome,
                            };
                            let _ = crate::auth::browser::try_open(&automatic_url);
                            match run_oauth_callback_panel(
                                &mut guard.terminal,
                                "\u{25B8} Authorize with Anthropic".to_string(),
                                automatic_url,
                                Some(manual_url),
                                port,
                                listener,
                            )
                            .await?
                            {
                                CallbackPanelOutcome::Completed { code, state } => {
                                    
                                    match handshake
                                        .finalize(code, state, false)
                                        .await
                                    {
                                        Ok(_) => {
                                            initial_provider = provider;
                                            base_model =
                                                provider.default_model().to_string();
                                            welcome_just_completed = true;
                                            break 'welcome;
                                        }
                                        Err(_err) => continue 'welcome,
                                    }
                                }
                                CallbackPanelOutcome::ManualSubmit(raw) => {
                                    let parsed = crate::auth::anthropic::parse_callback_input(&raw);
                                    match parsed {
                                        Ok((code, state)) => {
                                            match handshake
                                                .finalize(code, state, true)
                                                .await
                                            {
                                                Ok(_) => {
                                                    initial_provider = provider;
                                                    base_model = provider
                                                        .default_model()
                                                        .to_string();
                                                    welcome_just_completed = true;
                                                    break 'welcome;
                                                }
                                                Err(_) => continue 'welcome,
                                            }
                                        }
                                        Err(_) => continue 'welcome,
                                    }
                                }
                                CallbackPanelOutcome::Cancel => continue 'welcome,
                                CallbackPanelOutcome::Quit => {
                                    guard.restore();
                                    return Ok(());
                                }
                            }
                        }
                        ProviderId::Codex => {
                            let mut handshake =
                                match crate::auth::codex::begin_login() {
                                    Ok(h) => h,
                                    Err(_) => continue 'welcome,
                                };
                            let url = handshake.authorize_url().to_string();
                            let port = handshake.port();
                            let listener = match handshake.take_listener() {
                                Some(l) => l,
                                None => continue 'welcome,
                            };
                            let _ = crate::auth::browser::try_open(&url);
                            match run_oauth_callback_panel(
                                &mut guard.terminal,
                                "\u{25B8} Authorize with ChatGPT".to_string(),
                                url,
                                None,
                                port,
                                listener,
                            )
                            .await?
                            {
                                CallbackPanelOutcome::Completed { code, state } => {
                                    match handshake.finalize(code, state).await {
                                        Ok(_) => {
                                            initial_provider = provider;
                                            base_model =
                                                provider.default_model().to_string();
                                            welcome_just_completed = true;
                                            break 'welcome;
                                        }
                                        Err(_) => continue 'welcome,
                                    }
                                }
                                CallbackPanelOutcome::ManualSubmit(raw) => {
                                    match parse_manual_codex_paste(&raw) {
                                        Ok((code, state)) => {
                                            match handshake
                                                .finalize(code, state)
                                                .await
                                            {
                                                Ok(_) => {
                                                    initial_provider = provider;
                                                    base_model = provider
                                                        .default_model()
                                                        .to_string();
                                                    welcome_just_completed = true;
                                                    break 'welcome;
                                                }
                                                Err(_) => continue 'welcome,
                                            }
                                        }
                                        Err(_) => continue 'welcome,
                                    }
                                }
                                CallbackPanelOutcome::Cancel => continue 'welcome,
                                CallbackPanelOutcome::Quit => {
                                    guard.restore();
                                    return Ok(());
                                }
                            }
                        }
                        ProviderId::Kimi => {
                            let console_url =
                                crate::fingerprint::kimi::CONSOLE_URL.to_string();
                            match run_api_key_panel(
                                &mut guard.terminal,
                                console_url,
                            )
                            .await?
                            {
                                ApiKeyPanelOutcome::Submit(raw) => {
                                    let creds = crate::auth::kimi::CachedCreds {
                                        api_key: raw.trim().to_string(),
                                    };
                                    match crate::auth::kimi::save_credentials(&creds)
                                    {
                                        Ok(()) => {
                                            initial_provider = provider;
                                            base_model =
                                                provider.default_model().to_string();
                                            welcome_just_completed = true;
                                            break 'welcome;
                                        }
                                        Err(_) => continue 'welcome,
                                    }
                                }
                                ApiKeyPanelOutcome::Cancel => continue 'welcome,
                                ApiKeyPanelOutcome::Quit => {
                                    guard.restore();
                                    return Ok(());
                                }
                            }
                        }
                        _ => {

                            guard.restore();
                            let r = run_provider_login(provider).await;
                            guard = TerminalGuard::enter()?;
                            match r {
                                Ok(()) => {
                                    initial_provider = provider;
                                    base_model = provider.default_model().to_string();
                                    welcome_just_completed = true;
                                    break 'welcome;
                                }
                                Err(_) => continue 'welcome,
                            }
                        }
                    }
                }
                WelcomeGateOutcome::Quit => {
                    guard.restore();
                    return Ok(());
                }
            }
        }
    }

    if welcome_just_completed {
        settings.default_provider = Some(initial_provider.slug().to_string());
        settings.default_model = Some(base_model.clone());
        let persist = crate::state::persistence::PersistenceState::new(settings.clone());
        if let Err(e) = persist.flush() {
            tracing::warn!(?e, "welcome: failed to persist default provider+model");
        }
    }

    let res = event_loop(
        &mut guard.terminal,
        registry,
        base_model,
        thinking,
        initial_provider,
        initial_permission_mode,
        settings,
        resume_intent,
    )
    .await;
    guard.restore();
    match res {
        Ok(session_id) => {
            if let Some(id) = session_id {
                use std::io::Write as _;
                let mut stdout = std::io::stdout();
                let _ = writeln!(
                    stdout,
                    "\n\x1b[2mResume this session with:\notherside --resume {id}\x1b[0m"
                );
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

enum WelcomeGateOutcome {
    Proceed(crate::config::providers::ProviderId),
    Quit,
}

async fn run_provider_login(
    provider: crate::config::providers::ProviderId,
) -> Result<()> {
    use crate::config::providers::ProviderId;
    match provider {
        ProviderId::ClaudeCode => {
            crate::auth::anthropic::login_interactive().await.map(|_| ())
        }
        ProviderId::Codex => {
            crate::auth::codex::login_interactive().await.map(|_| ())
        }
        ProviderId::Kimi => {
            crate::auth::kimi::login_interactive().map(|_| ())
        }
        ProviderId::GeminiCli => {
            crate::auth::gemini::login_interactive().await.map(|_| ())
        }
        ProviderId::OpenAiCustom => Err(Error::Other(format!(
            "provider {} has no login flow",
            provider.slug()
        ))),
    }
}

enum CallbackPanelOutcome {
    
    Completed { code: String, state: String },
    
    ManualSubmit(String),
    
    Cancel,
    
    Quit,
}

async fn run_oauth_callback_panel(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    title: String,
    url: String,
    manual_url: Option<String>,
    port: u16,
    listener: std::net::TcpListener,
) -> Result<CallbackPanelOutcome> {
    use futures::StreamExt;

    listener
        .set_nonblocking(true)
        .map_err(|e| Error::Other(format!("listener non-blocking: {e}")))?;
    let tokio_listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|e| Error::Other(format!("tokio listener convert: {e}")))?;

    let mut st = welcome::OAuthCallbackWaitState {
        title,
        url,
        manual_url,
        port,
        spinner_tick: 0,
        input: String::new(),
        error: None,
    };
    let mut key_stream = EventStream::new();

    terminal
        .draw(|f| welcome::draw_oauth_callback(f, f.area(), &st))
        .map_err(|e| Error::Tui(format!("draw oauth callback: {e}")))?;

    loop {
        tokio::select! {
            accept_res = tokio_listener.accept() => {
                let (tokio_stream, _addr) = accept_res
                    .map_err(|e| Error::Other(format!("accept: {e}")))?;
                let std_stream = tokio_stream
                    .into_std()
                    .map_err(|e| Error::Other(format!("stream into_std: {e}")))?;
                std_stream
                    .set_nonblocking(false)
                    .map_err(|e| Error::Other(format!("stream blocking: {e}")))?;
                let parsed = tokio::task::spawn_blocking(move || {
                    crate::auth::codex::parse_callback_stream(std_stream)
                })
                .await
                .map_err(|e| Error::Other(format!("parse task: {e}")))??;
                return Ok(CallbackPanelOutcome::Completed {
                    code: parsed.0,
                    state: parsed.1,
                });
            }
            maybe_evt = key_stream.next() => {
                match maybe_evt {
                    Some(Ok(CtEvent::Paste(s))) => {
                        let cleaned = s.trim_end_matches(['\r', '\n']);
                        st.input.push_str(cleaned);
                        st.error = None;
                        terminal
                            .draw(|f| welcome::draw_oauth_callback(f, f.area(), &st))
                            .map_err(|e| Error::Tui(format!("draw oauth callback: {e}")))?;
                    }
                    Some(Ok(CtEvent::Key(k))) => {
                        if k.kind != KeyEventKind::Press {
                            continue;
                        }
                        match welcome::handle_callback_key(k, &mut st) {
                            welcome::CallbackKeyOutcome::Stay => {
                                terminal
                                    .draw(|f| welcome::draw_oauth_callback(f, f.area(), &st))
                                    .map_err(|e| Error::Tui(format!("draw oauth callback: {e}")))?;
                            }
                            welcome::CallbackKeyOutcome::Submit(raw) => {
                                return Ok(CallbackPanelOutcome::ManualSubmit(raw));
                            }
                            welcome::CallbackKeyOutcome::Cancel => {
                                return Ok(CallbackPanelOutcome::Cancel);
                            }
                            welcome::CallbackKeyOutcome::Quit => {
                                return Ok(CallbackPanelOutcome::Quit);
                            }
                        }
                    }
                    Some(Ok(CtEvent::Resize(_, _))) => {
                        terminal
                            .draw(|f| welcome::draw_oauth_callback(f, f.area(), &st))
                            .map_err(|e| Error::Tui(format!("draw oauth callback: {e}")))?;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        return Err(Error::Tui(format!(
                            "oauth callback event stream: {e}"
                        )));
                    }
                    None => return Ok(CallbackPanelOutcome::Quit),
                }
            }
        }
    }
}

fn parse_manual_codex_paste(raw: &str) -> std::result::Result<(String, String), String> {
    let s = raw.trim();
    if let Some((c, st)) = s.split_once('#') {
        if !c.is_empty() && !st.is_empty() {
            return Ok((c.to_string(), st.to_string()));
        }
    }
    if let Ok(url) = url::Url::parse(s) {
        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.to_string()),
                "state" => state = Some(v.to_string()),
                _ => {}
            }
        }
        if let (Some(c), Some(s)) = (code, state) {
            return Ok((c, s));
        }
    }
    if s.contains('=') {
        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        for pair in s.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                match k {
                    "code" => code = Some(v.to_string()),
                    "state" => state = Some(v.to_string()),
                    _ => {}
                }
            }
        }
        if let (Some(c), Some(s)) = (code, state) {
            return Ok((c, s));
        }
    }
    Err(format!(
        "couldn't parse paste — expected `<code>#<state>` or the full callback URL"
    ))
}

enum ApiKeyPanelOutcome {
    Submit(String),
    Cancel,
    Quit,
}

enum TextFieldOutcome {
    Submit(String),
    Cancel,
    Quit,
}

async fn run_text_field_panel(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    title: String,
    instructions: String,
    placeholder: String,
    prefill: String,
) -> Result<TextFieldOutcome> {
    use futures::StreamExt;

    let mut st = welcome::TextFieldState {
        title,
        instructions,
        placeholder,
        input: prefill,
        error: None,
    };
    let mut key_stream = EventStream::new();

    terminal
        .draw(|f| welcome::draw_text_field_panel(f, f.area(), &st))
        .map_err(|e| Error::Tui(format!("draw text field: {e}")))?;

    loop {
        match key_stream.next().await {
            Some(Ok(CtEvent::Paste(s))) => {
                let cleaned = s.trim_end_matches(['\r', '\n']);
                st.input.push_str(cleaned);
                st.error = None;
                terminal
                    .draw(|f| welcome::draw_text_field_panel(f, f.area(), &st))
                    .map_err(|e| Error::Tui(format!("draw text field: {e}")))?;
            }
            Some(Ok(CtEvent::Key(k))) => {
                if k.kind != KeyEventKind::Press {
                    continue;
                }
                match welcome::handle_text_field_key(k, &mut st) {
                    welcome::PasteOutcome::Stay => {
                        terminal
                            .draw(|f| welcome::draw_text_field_panel(f, f.area(), &st))
                            .map_err(|e| Error::Tui(format!("draw text field: {e}")))?;
                    }
                    welcome::PasteOutcome::Submit(raw) => {
                        return Ok(TextFieldOutcome::Submit(raw));
                    }
                    welcome::PasteOutcome::Cancel => {
                        return Ok(TextFieldOutcome::Cancel);
                    }
                    welcome::PasteOutcome::Quit => {
                        return Ok(TextFieldOutcome::Quit);
                    }
                }
            }
            Some(Ok(CtEvent::Resize(_, _))) => {
                terminal
                    .draw(|f| welcome::draw_text_field_panel(f, f.area(), &st))
                    .map_err(|e| Error::Tui(format!("draw text field: {e}")))?;
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => {
                return Err(Error::Tui(format!("text field event stream: {e}")));
            }
            None => return Ok(TextFieldOutcome::Quit),
        }
    }
}

async fn run_openai_custom_form(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    existing: Option<crate::config::settings::OpenAiCompatibleSettings>,
) -> Result<Option<(Option<String>, Option<String>, Option<String>)>> {
    use crate::config::settings::OpenAiCompatibleSettings;
    let existing = existing.unwrap_or_default();

    let base_prefill = existing.base_url.clone().unwrap_or_default();
    let base_url = match run_text_field_panel(
        terminal,
        "\u{25B8} OpenAI Custom \u{00B7} 1/3 Base URL".into(),
        "Enter the base URL of your OpenAI-compatible endpoint:".into(),
        OpenAiCompatibleSettings::DEFAULT_BASE_URL.to_string(),
        base_prefill,
    )
    .await?
    {
        TextFieldOutcome::Submit(v) => {
            if v.is_empty() {
                Some(OpenAiCompatibleSettings::DEFAULT_BASE_URL.to_string())
            } else {
                Some(v)
            }
        }
        TextFieldOutcome::Cancel | TextFieldOutcome::Quit => return Ok(None),
    };

    let key_prefill = existing.api_key.clone().unwrap_or_default();
    let api_key = match run_text_field_panel(
        terminal,
        "\u{25B8} OpenAI Custom \u{00B7} 2/3 API key (optional)".into(),
        "Paste an API key, or leave blank for unauthenticated local endpoints:".into(),
        "unauthenticated".into(),
        key_prefill,
    )
    .await?
    {
        TextFieldOutcome::Submit(v) => Some(v),
        TextFieldOutcome::Cancel | TextFieldOutcome::Quit => return Ok(None),
    };

    let model_prefill = existing.model.clone().unwrap_or_default();
    let model = match run_text_field_panel(
        terminal,
        "\u{25B8} OpenAI Custom \u{00B7} 3/3 Model slug".into(),
        "Enter the default model slug your endpoint serves:".into(),
        OpenAiCompatibleSettings::DEFAULT_MODEL.to_string(),
        model_prefill,
    )
    .await?
    {
        TextFieldOutcome::Submit(v) => {
            if v.is_empty() {
                Some(OpenAiCompatibleSettings::DEFAULT_MODEL.to_string())
            } else {
                Some(v)
            }
        }
        TextFieldOutcome::Cancel | TextFieldOutcome::Quit => return Ok(None),
    };

    Ok(Some((base_url, api_key, model)))
}

async fn run_api_key_panel(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    console_url: String,
) -> Result<ApiKeyPanelOutcome> {
    use futures::StreamExt;

    let mut st = welcome::OAuthPasteState {
        url: console_url,
        input: String::new(),
        error: None,
    };
    let mut key_stream = EventStream::new();

    terminal
        .draw(|f| welcome::draw_api_key_paste(f, f.area(), &st))
        .map_err(|e| Error::Tui(format!("draw api key panel: {e}")))?;

    loop {
        match key_stream.next().await {
            Some(Ok(CtEvent::Paste(s))) => {
                let cleaned = s.trim_end_matches(['\r', '\n']);
                st.input.push_str(cleaned);
                st.error = None;
                terminal
                    .draw(|f| welcome::draw_api_key_paste(f, f.area(), &st))
                    .map_err(|e| Error::Tui(format!("draw api key panel: {e}")))?;
            }
            Some(Ok(CtEvent::Key(k))) => {
                if k.kind != KeyEventKind::Press {
                    continue;
                }
                match welcome::handle_paste_key(k, &mut st) {
                    welcome::PasteOutcome::Stay => {
                        terminal
                            .draw(|f| welcome::draw_api_key_paste(f, f.area(), &st))
                            .map_err(|e| Error::Tui(format!("draw api key panel: {e}")))?;
                    }
                    welcome::PasteOutcome::Submit(raw) => {
                        return Ok(ApiKeyPanelOutcome::Submit(raw));
                    }
                    welcome::PasteOutcome::Cancel => {
                        return Ok(ApiKeyPanelOutcome::Cancel);
                    }
                    welcome::PasteOutcome::Quit => {
                        return Ok(ApiKeyPanelOutcome::Quit);
                    }
                }
            }
            Some(Ok(CtEvent::Resize(_, _))) => {
                terminal
                    .draw(|f| welcome::draw_api_key_paste(f, f.area(), &st))
                    .map_err(|e| Error::Tui(format!("draw api key panel: {e}")))?;
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => {
                return Err(Error::Tui(format!("api key event stream: {e}")));
            }
            None => return Ok(ApiKeyPanelOutcome::Quit),
        }
    }
}

async fn run_welcome_gate(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
) -> Result<WelcomeGateOutcome> {
    use futures::StreamExt;

    let mut state = welcome::WelcomeState::new();
    let mut key_stream = EventStream::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(50));

    terminal
        .draw(|f| welcome::draw(f, f.area(), &state))
        .map_err(|e| Error::Tui(format!("draw welcome: {e}")))?;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                
            }
            maybe_evt = key_stream.next() => {
                match maybe_evt {
                    Some(Ok(CtEvent::Key(k))) => {
                        if k.kind != KeyEventKind::Press {
                            continue;
                        }
                        match welcome::handle_key(k, &mut state) {
                            welcome::WelcomeOutcome::Stay => {
                                terminal
                                    .draw(|f| welcome::draw(f, f.area(), &state))
                                    .map_err(|e| Error::Tui(format!("draw welcome: {e}")))?;
                            }
                            welcome::WelcomeOutcome::LoginIntent(p) => {
                                return Ok(WelcomeGateOutcome::Proceed(p));
                            }
                            welcome::WelcomeOutcome::Quit => {
                                return Ok(WelcomeGateOutcome::Quit);
                            }
                        }
                    }
                    Some(Ok(CtEvent::Resize(_, _))) => {
                        terminal
                            .draw(|f| welcome::draw(f, f.area(), &state))
                            .map_err(|e| Error::Tui(format!("draw welcome: {e}")))?;
                    }
                    Some(Ok(_)) => {
                        
                    }
                    Some(Err(e)) => {
                        return Err(Error::Tui(format!("welcome event stream: {e}")));
                    }
                    None => {
                        return Ok(WelcomeGateOutcome::Quit);
                    }
                }
            }
        }
    }
}

async fn dispatch_pending_login(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    provider: crate::config::providers::ProviderId,
    st: &mut ConversationState,
) -> Result<()> {
    use crate::config::providers::ProviderId;
    let mut succeeded = false;
    match provider {
        ProviderId::ClaudeCode => {
            let mut handshake = match crate::auth::anthropic::begin_login() {
                Ok(h) => h,
                Err(e) => {
                    st.set_feedback(format!("login failed: {e}"));
                    return Ok(());
                }
            };
            let automatic_url = handshake.automatic_url().to_string();
            let manual_url = handshake.manual_url().to_string();
            let port = handshake.port();
            let listener = match handshake.take_listener() {
                Some(l) => l,
                None => {
                    st.set_feedback("login failed: listener unavailable");
                    return Ok(());
                }
            };
            let _ = crate::auth::browser::try_open(&automatic_url);
            match run_oauth_callback_panel(
                terminal,
                "\u{25B8} Authorize with Anthropic".to_string(),
                automatic_url,
                Some(manual_url),
                port,
                listener,
            )
            .await?
            {
                CallbackPanelOutcome::Completed { code, state } => {
                    match handshake.finalize(code, state, false).await {
                        Ok(_) => succeeded = true,
                        Err(e) => st.set_feedback(format!("login failed: {e}")),
                    }
                }
                CallbackPanelOutcome::ManualSubmit(raw) => {
                    match crate::auth::anthropic::parse_callback_input(&raw) {
                        Ok((code, state)) => {
                            match handshake.finalize(code, state, true).await {
                                Ok(_) => succeeded = true,
                                Err(e) => {
                                    st.set_feedback(format!("login failed: {e}"))
                                }
                            }
                        }
                        Err(e) => st.set_feedback(format!("login failed: {e}")),
                    }
                }
                CallbackPanelOutcome::Cancel | CallbackPanelOutcome::Quit => {}
            }
        }
        ProviderId::Codex => {
            let mut handshake = match crate::auth::codex::begin_login() {
                Ok(h) => h,
                Err(e) => {
                    st.set_feedback(format!("login failed: {e}"));
                    return Ok(());
                }
            };
            let url = handshake.authorize_url().to_string();
            let port = handshake.port();
            let listener = match handshake.take_listener() {
                Some(l) => l,
                None => {
                    st.set_feedback("login failed: listener unavailable");
                    return Ok(());
                }
            };
            let _ = crate::auth::browser::try_open(&url);
            match run_oauth_callback_panel(
                terminal,
                "\u{25B8} Authorize with ChatGPT".to_string(),
                url,
                None,
                port,
                listener,
            )
            .await?
            {
                CallbackPanelOutcome::Completed { code, state } => {
                    match handshake.finalize(code, state).await {
                        Ok(_) => succeeded = true,
                        Err(e) => st.set_feedback(format!("login failed: {e}")),
                    }
                }
                CallbackPanelOutcome::ManualSubmit(raw) => {
                    match parse_manual_codex_paste(&raw) {
                        Ok((code, state)) => match handshake.finalize(code, state).await {
                            Ok(_) => succeeded = true,
                            Err(e) => st.set_feedback(format!("login failed: {e}")),
                        },
                        Err(e) => st.set_feedback(format!("login failed: {e}")),
                    }
                }
                CallbackPanelOutcome::Cancel | CallbackPanelOutcome::Quit => {}
            }
        }
        ProviderId::Kimi => {
            let console_url = crate::fingerprint::kimi::CONSOLE_URL.to_string();
            match run_api_key_panel(terminal, console_url).await? {
                ApiKeyPanelOutcome::Submit(raw) => {
                    let creds = crate::auth::kimi::CachedCreds {
                        api_key: raw.trim().to_string(),
                    };
                    match crate::auth::kimi::save_credentials(&creds) {
                        Ok(()) => succeeded = true,
                        Err(e) => st.set_feedback(format!("login failed: {e}")),
                    }
                }
                ApiKeyPanelOutcome::Cancel | ApiKeyPanelOutcome::Quit => {}
            }
        }
        ProviderId::OpenAiCustom => {
            let existing = st
                .persistence
                .settings
                .providers
                .openai_compatible
                .clone();
            match run_openai_custom_form(terminal, existing).await? {
                Some((base_url, api_key, model)) => {
                    if let Err(e) = crate::state::broker::set_openai_custom_fields(
                        st, base_url, api_key, model,
                    ) {
                        st.set_feedback(format!("openai-custom save failed: {e}"));
                    } else {
                        succeeded = true;
                    }
                }
                None => {}
            }
        }
        ProviderId::GeminiCli => {
            let mut handshake = match crate::auth::gemini::begin_login() {
                Ok(h) => h,
                Err(e) => {
                    st.set_feedback(format!("login failed: {e}"));
                    return Ok(());
                }
            };
            let url = handshake.authorize_url().to_string();
            let port = handshake.port();
            let listener = match handshake.take_listener() {
                Some(l) => l,
                None => {
                    st.set_feedback("login failed: listener unavailable");
                    return Ok(());
                }
            };
            let _ = crate::auth::browser::try_open(&url);
            match run_oauth_callback_panel(
                terminal,
                "\u{25B8} Authorize with Google".to_string(),
                url,
                None,
                port,
                listener,
            )
            .await?
            {
                CallbackPanelOutcome::Completed { code, state } => {
                    match handshake.finalize(code, state).await {
                        Ok(_) => succeeded = true,
                        Err(e) => st.set_feedback(format!("login failed: {e}")),
                    }
                }
                CallbackPanelOutcome::ManualSubmit(_)
                | CallbackPanelOutcome::Cancel
                | CallbackPanelOutcome::Quit => {}
            }
        }
    }

    if succeeded {
        if let Err(e) = crate::state::broker::set_active_provider(st, provider) {
            tracing::warn!(?e, "post-login provider switch failed");
        }
        st.set_feedback(format!("logged in · {}", provider.slug()));
    }
    Ok(())
}

fn dispatch_pending_logout(
    provider: crate::config::providers::ProviderId,
    st: &mut ConversationState,
) {
    match crate::state::broker::logout_provider(st, provider) {
        Ok(()) => st.set_feedback(format!("logged out · {}", provider.slug())),
        Err(e) => st.set_feedback(format!("logout failed: {e}")),
    }
}

async fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    registry: Arc<Registry>,
    base_model: String,
    mut thinking: Option<ThinkingConfig>,
    initial_provider: crate::config::providers::ProviderId,
    initial_permission_mode: crate::config::PermissionMode,
    settings: crate::config::settings::Settings,
    resume_intent: ResumeIntent,
) -> Result<Option<crate::sessions::SessionId>> {
    let mut st = ConversationState::new_for_model_with_provider(
        &base_model,
        initial_permission_mode,
        initial_provider,
    );

    let _ = crate::tasks::store::install_global(st.tasks.clone());

    st.render_verbose = settings.verbose.unwrap_or(false);

    match crate::config::config_dir() {
        Ok(cfg_dir) => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let resume_outcome: std::result::Result<
                Option<(crate::sessions::SessionHandle, Vec<crate::sessions::Record>)>,
                crate::error::Error,
            > = match &resume_intent {
                ResumeIntent::None => Ok(None),
                ResumeIntent::Latest => crate::sessions::resume_latest(&cfg_dir, &cwd),
                ResumeIntent::Picker => match pick_session_pre_tui(&cfg_dir, &cwd) {
                    PickerOutcome::Resume(id) => {
                        crate::sessions::resume(&cfg_dir, &cwd, &id).map(Some)
                    }
                    PickerOutcome::Latest => crate::sessions::resume_latest(&cfg_dir, &cwd),
                    PickerOutcome::Fresh => Ok(None),
                },
                ResumeIntent::Specific(id_hex) => {
                    match crate::sessions::id::SessionId::from_hex(id_hex) {
                        Some(id) => crate::sessions::resume(&cfg_dir, &cwd, &id).map(Some),
                        None => Err(crate::error::Error::Other(format!(
                            "session id {id_hex:?} is not a valid uuid-like hex"
                        ))),
                    }
                }
            };

            match resume_outcome {
                Ok(Some((handle, records))) => {
                    st.session_id = Some(handle.id.clone());
                    st.session_writer = Some(handle.writer);
                    state::hydrate_from_records(&mut st, &records);
                }
                Ok(None) => {
                    if matches!(resume_intent, ResumeIntent::Latest) {
                        tracing::info!("--continue: no prior session found, starting fresh");
                    }
                    match crate::sessions::open_new(&cfg_dir, &cwd) {
                        Ok(handle) => {
                            st.session_id = Some(handle.id.clone());
                            st.session_writer = Some(handle.writer);
                        }
                        Err(e) => {
                            tracing::warn!(?e, "session transcript unavailable");
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(?e, "resume failed; starting fresh session");
                    match crate::sessions::open_new(&cfg_dir, &cwd) {
                        Ok(handle) => {
                            st.session_id = Some(handle.id.clone());
                            st.session_writer = Some(handle.writer);
                        }
                        Err(e) => {
                            tracing::warn!(?e, "session transcript unavailable");
                        }
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(?e, "config dir unavailable; sessions disabled");
        }
    }

    if let (Ok(cfg_dir), Some(session_id)) = (crate::config::config_dir(), st.session_id.as_ref()) {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let project = crate::sessions::paths::project_dir(&cfg_dir, &cwd);
        let session_root = project.join(session_id.to_string());
        crate::tasks::disk_output::install_root(session_root);
    }

    if thinking.is_none() {
        if let Some(level_str) = settings.effort_level.as_deref() {
            thinking = crate::thinking::config_from_effort_label(level_str);
        }
    }
    st.persistence.settings = settings;

    if let Err(e) = crate::state::broker::seed_boot_defaults(&mut st) {
        tracing::warn!(?e, "initial settings write failed");
    }

    st.session.thinking = thinking;
    st.session.effort_label = thinking
        .as_ref()
        .and_then(crate::thinking::label_from_thinking);
    
    crate::state::dispatch::set_model(st.session.model.clone());
    crate::state::dispatch::set_thinking(thinking);
    let mut key_stream = EventStream::new();

    let mut ticker = tokio::time::interval(Duration::from_millis(50));
    let mut spinner_tick: u64 = 0;

    let (tx, mut rx) = mpsc::channel::<StreamEvent>(1024);

    st.prune_feedback();
    terminal
        .draw(|f| render::render(f, &st, &st.session.model, spinner_tick))
        .map_err(|e| Error::Tui(format!("draw: {e}")))?;

    loop {
        tokio::select! {

            _ = ticker.tick() => {
                spinner_tick = spinner_tick.wrapping_add(1);

                if let Some(panel) = st.active_agents_panel.as_mut() {
                    panel.refresh(
                        &st.tasks,
                        crate::agent::subagents::registry::all(),
                    );
                }

                if let Some(panel) = st.active_tasks_panel.as_mut() {
                    panel.refresh(&st.tasks);
                }

                for entry in crate::tools::cron::drain_due_wakeups() {
                    st.push_system_note(format!("⏰ wakeup: {}", entry.message));
                }

                if let Some(store) = crate::tasks::store::current_global() {
                    for record in store.drain_unrendered_completions() {
                        if matches!(record.kind, crate::tasks::TaskKind::Agent)
                            && !record.is_backgrounded
                        {
                            continue;
                        }
                        if matches!(
                            record.display_mode,
                            crate::tasks::TaskDisplayMode::InlineAnchor
                        ) {
                            continue;
                        }
                        let line = render_completion_line(&record);
                        st.push_system_note(line);
                    }
                }

                refresh_fork_skill_anchor(&mut st);

                let _ = auto_trigger_pending_notifications(
                    &mut st, &registry, &base_model, &tx,
                );
            }

            maybe = rx.recv() => {
                match maybe {
                    Some(StreamEvent::Delta(s)) => {
                        tracing::info!(
                            target: "otherside::queue",
                            delta_len = s.len(),
                            buffer_len_after = st.current_assistant_buffer.len() + s.len(),
                            "Delta received"
                        );
                        st.append_stream_delta(&s);
                    }
                    Some(StreamEvent::Done) => {
                        tracing::info!(
                            target: "otherside::queue",
                            queue_depth = st.queued_messages.len(),
                            buffer_len = st.current_assistant_buffer.len(),
                            messages_len = st.messages.len(),
                            "StreamEvent::Done received"
                        );
                        let content = st.current_assistant_buffer.clone();
                        let usage = Some(serde_json::json!({
                            "input_tokens": st.input_tokens,
                            "output_tokens": st.output_tokens,
                            "cumulative_output_tokens": st.cumulative_output_tokens,
                            "thought_ms": st.thought_ms,
                        }));
                        if !content.is_empty() {
                            st.append_record(crate::sessions::Record::AssistantMessage {
                                ts: crate::sessions::record::now_iso(),
                                content,
                                thinking: None,
                                usage,
                                provider: Some(st.provider_id.slug().to_string()),
                                model: Some(st.session.model.clone()),
                            });
                        }

                        if let Ok(cwd) = std::env::current_dir() {
                            let provider_slug = st.provider_id.slug().to_string();
                            let model = st.session.model.clone();
                            let input = st.input_tokens;
                            let output = st.output_tokens;
                            let session_id =
                                st.session_id.as_ref().map(|s| s.as_str().to_string());
                            let ts = crate::sessions::record::now_iso();
                            if let Err(e) = crate::config::projects::record_turn_usage(
                                &cwd,
                                &provider_slug,
                                &model,
                                input,
                                output,
                                session_id,
                                ts,
                            ) {
                                tracing::warn!(?e, "projects usage write failed");
                            }
                        }

                        st.finish_stream();

                        drain_pending_inputs(
                            &mut st, &registry, &base_model, &tx,
                        );
                    }
                    Some(StreamEvent::Error(e)) => {
                        st.fail_stream(e);
                        drain_pending_inputs(
                            &mut st, &registry, &base_model, &tx,
                        );
                    }
                    Some(StreamEvent::ToolCallStart { id, name, args }) => {
                        
                        if crate::tools::is_hidden_tool(&name) {
                            continue;
                        }
                        
                        if !st.current_assistant_buffer.is_empty() {
                            let prose = st.current_assistant_buffer.clone();
                            st.append_record(crate::sessions::Record::AssistantMessage {
                                ts: crate::sessions::record::now_iso(),
                                content: prose,
                                thinking: None,
                                usage: None,
                                provider: Some(st.provider_id.slug().to_string()),
                                model: Some(st.session.model.clone()),
                            });
                        }
                        st.flush_assistant_buffer();
                        st.append_record(crate::sessions::Record::ToolCall {
                            ts: crate::sessions::record::now_iso(),
                            tool_name: name.clone(),
                            args: args.clone(),
                            call_id: id.clone(),
                            provider: Some(st.provider_id.slug().to_string()),
                            model: Some(st.session.model.clone()),
                        });
                        st.begin_tool_call(id, name, args);
                    }
                    Some(StreamEvent::ToolCallFinish { id, result, elapsed_ms }) => {
                        
                        let tool_name = st
                            .active_tool_calls
                            .iter()
                            .find(|e| e.id == id)
                            .map(|e| e.name.clone());
                        if tool_name.as_deref().is_none() {
                            continue;
                        }
                        let (record_result, is_error) = match &result {
                            Ok(v) => (v.clone(), false),
                            Err(s) => (serde_json::Value::String(s.clone()), true),
                        };
                        st.append_record(crate::sessions::Record::ToolResult {
                            ts: crate::sessions::record::now_iso(),
                            call_id: id.clone(),
                            result: record_result,
                            is_error,
                        });
                        st.finish_tool_call(&id, result, elapsed_ms);
                    }
                    Some(StreamEvent::Usage { input_tokens, output_tokens }) => {
                        st.update_usage(input_tokens, output_tokens);
                    }
                    Some(StreamEvent::PermissionAsk { tool_name, args_preview, rule, reply }) => {

                        st.active_menu = None;
                        st.pending_permission = Some(menu::PendingPermissionPrompt::new(
                            tool_name,
                            args_preview,
                            rule,
                            reply,
                        ));
                    }
                    Some(StreamEvent::AskUserQuestion { question, hint, reply }) => {
                        st.active_menu = None;
                        st.pending_question = Some(menu::PendingQuestion::new(
                            question,
                            hint,
                            reply,
                        ));
                    }
                    Some(StreamEvent::NestedToolStart { name, args }) => {
                        st.push_nested_tool_start(&name, args);
                    }
                    Some(StreamEvent::NestedToolFinish { success }) => {
                        st.push_nested_tool_finish(success);
                    }
                    Some(StreamEvent::NestedUsage { input_tokens, output_tokens }) => {
                        st.push_nested_usage(input_tokens, output_tokens);
                    }
                    Some(StreamEvent::BackgroundAgentCompleted) => {
                    }
                    Some(StreamEvent::CompactDone { summary, is_auto }) => {
                        let kept = st.messages.len() as u64;
                        st.append_record(crate::sessions::Record::CompactionMark {
                            ts: crate::sessions::record::now_iso(),
                            summary_ref: format!("kept={kept};auto={is_auto}"),
                            provider: Some(st.provider_id.slug().to_string()),
                            model: Some(st.session.model.clone()),
                        });
                        st.compact_history_with_summary(Some(summary));
                        st.streaming = false;
                        st.compacting = false;
                        st.push_system_note("◇ Conversation compacted (ctrl+o for history)");
                        st.push_anchor(
                            "compact",
                            "",
                            "Compacted",
                            state::DisplayOrigin::Transcript,
                        );
                        drain_pending_inputs(
                            &mut st, &registry, &base_model, &tx,
                        );
                    }
                    Some(StreamEvent::CompactFailed { message }) => {
                        st.streaming = false;
                        st.compacting = false;
                        st.push_system_note(format!("⎿  compact failed: {message}"));
                    }
                    None => {

                        if st.streaming {
                            st.finish_stream();
                            drain_queue_head_if_any(
                                &mut st, &registry, &base_model, &tx,
                            );
                        }
                    }
                }
            }

            maybe = key_stream.next() => {
                match maybe {
                    Some(Ok(CtEvent::Key(k))) => {
                        if handle_key(k, &mut st, &registry, &base_model, &tx) {
                            break;
                        }
                        if let Some(provider) = st.pending_login_provider.take() {
                            dispatch_pending_login(terminal, provider, &mut st).await?;
                        }
                        if let Some(provider) = st.pending_logout_provider.take() {
                            dispatch_pending_logout(provider, &mut st);
                        }
                    }
                    Some(Ok(CtEvent::Resize(_, _))) => {

                    }
                    Some(Ok(CtEvent::Paste(text))) => {
                        handle_paste(&text, &mut st);
                    }
                    Some(Ok(_)) => {

                    }
                    Some(Err(e)) => {
                        return Err(Error::Tui(format!("event: {e}")));
                    }
                    None => {

                        break;
                    }
                }
            }
        }

        st.prune_feedback();
        terminal
            .draw(|f| render::render(f, &st, &st.session.model, spinner_tick))
            .map_err(|e| Error::Tui(format!("draw: {e}")))?;
    }

    let materialized = st
        .session_writer
        .as_ref()
        .map(|w| w.is_materialized())
        .unwrap_or(false);
    if materialized {
        Ok(st.session_id.clone())
    } else {
        Ok(None)
    }
}

fn handle_key(
    k: KeyEvent,
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {

    if k.kind != KeyEventKind::Press {
        return false;
    }

    if st.pending_question.is_some() {
        handle_question_key(k, st);
        return false;
    }

    if st.pending_permission.is_some() {
        handle_permission_key(k, st);
        return false;
    }

    if st.active_tasks_panel.is_some() {
        handle_tasks_panel_key(k, st);
        return false;
    }

    if st.active_agents_panel.is_some() {
        handle_agents_panel_key(k, st);
        return false;
    }

    if st.active_menu.is_some() {
        return handle_menu_key(k, st);
    }

    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let shift = k.modifiers.contains(KeyModifiers::SHIFT);

    let is_exit_arming_key = ctrl
        && matches!(k.code, KeyCode::Char('c') | KeyCode::Char('d'));
    if !is_exit_arming_key {
        st.clear_exit_armed();
    }

    {
        use crate::keybindings::{dispatch as kb_dispatch, Action, PredicateContext};
        let pred_ctx = PredicateContext {
            tasks: &st.tasks,
            dialog_open: st.active_menu.is_some(),
        };
        if let Some(action) = kb_dispatch(&k, &pred_ctx) {
            match action {
                Action::TaskBackground => {
                    
                    st.ctrl_b_armed_at = None;
                    let _ = st.tasks.background_all_running_foreground();
                    let _ = crate::tools::background_signal::signal_all();
                    return false;
                }
                Action::OpenBackgroundTasksDialog => {

                    st.push_system_note(
                        "(BackgroundTasksDialog renders in §7 — open via /tasks for now)"
                            .to_string(),
                    );
                    return false;
                }
            }
        }
    }

    match k.code {

        KeyCode::Char('c') if ctrl => {
            if st.cancel_stream() {
                drain_queue_head_if_any(st, registry, base_model, tx);
            } else if st.exit_confirmed() {
                return true;
            } else {
                st.arm_exit_confirmation("Ctrl+C");
            }
        }

        KeyCode::Esc => {
            if st.pill_focused {
                st.pill_focused = false;
            } else if st.autocomplete.is_some() {

                st.close_autocomplete();
                st.clear_input();
            } else if st.streaming {
                st.cancel_stream();
                drain_queue_head_if_any(st, registry, base_model, tx);
            } else {
                st.clear_input();
            }
            st.clear_exit_armed();
        }

        KeyCode::Char('d') if ctrl && st.input.is_empty() => {
            if st.exit_confirmed() && st.exit_armed_key == Some("Ctrl+D") {
                return true;
            } else {
                st.arm_exit_confirmation("Ctrl+D");
            }
        }

        KeyCode::Char('l') if ctrl => {}

        KeyCode::Char('o') if ctrl => {
            st.render_verbose = !st.render_verbose;
        }

        KeyCode::Char('u') if ctrl => {
            st.input.clear();
            st.refresh_autocomplete();
        }

        KeyCode::PageUp => st.scroll_up(10),
        KeyCode::PageDown => st.scroll_down(10),

        KeyCode::Up if shift => st.scroll_up(1),
        KeyCode::Down if shift => st.scroll_down(1),

        KeyCode::Home if ctrl => st.scroll_up(10_000),
        KeyCode::End if ctrl => st.scroll_to_bottom(),

        KeyCode::Up => {
            if let Some(ac) = st.autocomplete.as_mut() {
                ac.move_up();
            } else if st.input.is_empty() && st.has_queued_messages() {
                
                if let Some(tail) = st.pop_queue_tail() {
                    st.input = tail;
                    st.refresh_autocomplete();
                }
            }
        }
        KeyCode::Down => {
            if let Some(ac) = st.autocomplete.as_mut() {
                ac.move_down();
            } else if st.input.is_empty()
                && st.tasks.any_backgrounded()
                && st.active_tasks_panel.is_none()
                && st.active_agents_panel.is_none()
            {

                if !st.pill_focused {
                    st.pill_focused = true;
                } else {
                    st.pill_focused = false;
                    st.active_tasks_panel = Some(
                        crate::tui::slash::tasks_panel::TasksPanelState::new(
                            &st.tasks,
                        ),
                    );
                }
            }
        }

        KeyCode::Tab if shift => {
            if st.autocomplete.is_none() {
                st.cycle_permission_mode();
            }
        }
        KeyCode::BackTab => {
            if st.autocomplete.is_none() {
                st.cycle_permission_mode();
            }
        }
        KeyCode::Tab => {
            if let Some(ac) = st.autocomplete.as_ref() {
                if let Some(name) = ac.commit() {
                    st.input = format!("/{name}");
                    st.close_autocomplete();
                }
            }
        }

        KeyCode::Enter => {
            if shift {
                st.input_push_newline();
                st.refresh_autocomplete();
            } else if st.pill_focused
                && !st.streaming
                && st.input.is_empty()
                && st.tasks.any_backgrounded()
                && st.active_tasks_panel.is_none()
                && st.active_agents_panel.is_none()
            {
                
                st.pill_focused = false;
                st.active_tasks_panel = Some(
                    crate::tui::slash::tasks_panel::TasksPanelState::new(
                        &st.tasks,
                    ),
                );
            } else if st.streaming {
                let trimmed = st.input.trim();
                if !trimmed.is_empty() {
                    st.push_to_queue(st.input.clone());
                }
                st.input.clear();
                st.autocomplete = None;
            } else {
                if let Some(ac) = st.autocomplete.as_ref() {
                    if let Some(name) = ac.commit() {
                        st.input = format!("/{name}");
                    }
                    st.close_autocomplete();
                }
                if dispatch_slash(
                    st,
                    registry,
                    base_model,
                    tx,
                ) {
                    return true;
                }
            }
        }

        KeyCode::Backspace => {
            st.pill_focused = false;
            st.input_backspace();
            st.refresh_autocomplete();
        }
        KeyCode::Char('h') if ctrl => {
            st.pill_focused = false;
            st.input_backspace();
            st.refresh_autocomplete();
        }

        KeyCode::Char(c) if !ctrl => {
            st.pill_focused = false;
            st.input_push_char(c);
            st.refresh_autocomplete();
        }

        _ => {}
    }

    false
}

fn handle_menu_key(
    k: KeyEvent,
    st: &mut ConversationState,
) -> bool {
    use crate::tui::slash::catalog::PanelKind;
    if matches!(k.code, KeyCode::Esc) {
        if let Some(menu) = st.active_menu.as_mut() {
            
            let in_search = matches!(menu.kind, PanelKind::Settings(_))
                && !menu.settings_header_focused.unwrap_or(false)
                && !menu.settings_body_focused;
            if in_search && !menu.settings_search_query.is_empty() {
                menu.settings_search_query.clear();
                menu.cursor = 0;
                return false;
            }
        }
        if let Some(menu) = st.active_menu.take() {
            emit_panel_dismiss_anchor(st, &menu, None);
        }
        return false;
    }
    let Some(menu_state) = st.active_menu.as_mut() else {
        return false;
    };

    if let PanelKind::Settings(_) = menu_state.kind {
        let header_focused = menu_state.settings_header_focused.unwrap_or(false);
        let body_focused = menu_state.settings_body_focused;
        
        match k.code {
            
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab
                if header_focused =>
            {
                let direction: i32 = match k.code {
                    KeyCode::Right | KeyCode::Tab => 1,
                    _ => -1,
                };
                rotate_settings_tab(st, direction);
                return false;
            }
            
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab
                if body_focused =>
            {
                let direction: i32 = match k.code {
                    KeyCode::Right | KeyCode::Tab => 1,
                    _ => -1,
                };
                edit_settings_row(st, direction);
                return false;
            }
            
            KeyCode::Backspace
                if !header_focused
                    && !body_focused
                    && !menu_state.settings_search_query.is_empty() =>
            {
                menu_state.settings_search_query.pop();
                menu_state.cursor = 0;
                return false;
            }
            
            KeyCode::Char(c)
                if !header_focused
                    && !body_focused
                    && !k.modifiers.contains(KeyModifiers::CONTROL)
                    && !k.modifiers.contains(KeyModifiers::ALT)
                    && (c.is_alphanumeric() || c == ' ' || c == '-' || c == '_') =>
            {
                menu_state.settings_search_query.push(c);
                menu_state.cursor = 0;
                return false;
            }
            
            KeyCode::Char(' ') if body_focused => {
                edit_settings_row(st, 1);
                return false;
            }
            
            KeyCode::Up if !header_focused && !body_focused => {
                menu_state.settings_header_focused = Some(true);
                return false;
            }
            
            KeyCode::Up if body_focused => {
                let lc_query = menu_state.settings_search_query.to_lowercase();
                let first_visible_idx = menu_state
                    .options
                    .iter()
                    .enumerate()
                    .find(|(_, o)| {
                        !o.label.is_empty()
                            && o.action_id != "__line__"
                            && (lc_query.is_empty()
                                || o.label.to_lowercase().contains(&lc_query))
                    })
                    .map(|(i, _)| i);
                if first_visible_idx == Some(menu_state.cursor) {
                    menu_state.settings_body_focused = false;
                    return false;
                }
                menu_state.move_up();
                return false;
            }
            
            KeyCode::Down if header_focused => {
                menu_state.settings_header_focused = Some(false);
                menu_state.settings_body_focused = false;
                menu_state.cursor = 0;
                return false;
            }
            
            KeyCode::Down | KeyCode::Enter if !header_focused && !body_focused => {
                let lc_query = menu_state.settings_search_query.to_lowercase();
                let first_visible = menu_state
                    .options
                    .iter()
                    .enumerate()
                    .find(|(_, o)| {
                        !o.label.is_empty()
                            && o.action_id != "__line__"
                            && (lc_query.is_empty()
                                || o.label.to_lowercase().contains(&lc_query))
                    })
                    .map(|(i, _)| i);
                if let Some(idx) = first_visible {
                    menu_state.cursor = idx;
                    menu_state.settings_body_focused = true;
                }
                return false;
            }
            
            KeyCode::Down if body_focused => {
                let lc_query = menu_state.settings_search_query.to_lowercase();
                let n = menu_state.options.len();
                for _ in 0..n {
                    menu_state.move_down();
                    let visible = menu_state
                        .options
                        .get(menu_state.cursor)
                        .map(|o| {
                            lc_query.is_empty()
                                || o.label.to_lowercase().contains(&lc_query)
                        })
                        .unwrap_or(false);
                    if visible {
                        break;
                    }
                }
                return false;
            }
            
            KeyCode::Enter if body_focused => {
                commit_settings_row_enter(st);
                return false;
            }
            _ => {}
        }
    }

    if matches!(menu_state.kind, PanelKind::Effort) {
        match k.code {
            KeyCode::Left => {
                menu_state.move_left();
                return false;
            }
            KeyCode::Right => {
                menu_state.move_right();
                return false;
            }
            _ => {}
        }
    }

    if matches!(menu_state.kind, PanelKind::Model) {
        return handle_model_panel_key(k, st);
    }
    match k.code {
        KeyCode::Up => menu_state.move_up(),
        KeyCode::Down => menu_state.move_down(),
        KeyCode::Home => menu_state.jump_to_first(),
        KeyCode::End => menu_state.jump_to_last(),
        KeyCode::Enter => {
            let outcome = menu_state.commit_outcome();
            let menu = st.active_menu.take().expect("active_menu present");
            emit_panel_dismiss_anchor(st, &menu, outcome.as_ref());
            if let Some(outcome) = outcome {
                return apply_menu_outcome(st, outcome);
            }
        }
        _ => {}
    }
    false
}

fn handle_model_panel_key(
    k: KeyEvent,
    st: &mut ConversationState,
) -> bool {
    use crate::config::providers::PROVIDER_ORDER;
    use crate::tui::menu::ModelTabRow;

    let Some(menu_state) = st.active_menu.as_ref() else {
        return false;
    };
    let tabs_focused = menu_state.model_tabs_focused;
    let tab_index = menu_state.model_tab_index;
    let body_cursor = menu_state.model_body_cursor;
    let active_tab_clone = menu_state.active_model_tab().cloned();

    match k.code {
        KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab if tabs_focused => {
            let dir: i32 = match k.code {
                KeyCode::Right | KeyCode::Tab => 1,
                _ => -1,
            };
            let n = PROVIDER_ORDER.len() as i32;
            let next = (((tab_index as i32) + dir).rem_euclid(n)) as usize;
            st.model_panel_tab_index = next;
            st.model_panel_body_cursor = 0;
            rebuild_model_panel(st);
            false
        }
        KeyCode::Down | KeyCode::Enter if tabs_focused => {
            st.model_panel_tabs_focused = false;
            st.model_panel_body_cursor = 0;
            rebuild_model_panel(st);
            false
        }
        KeyCode::Up if !tabs_focused => {
            if body_cursor == 0 {
                st.model_panel_tabs_focused = true;
            } else {
                st.model_panel_body_cursor = body_cursor.saturating_sub(1);
            }
            rebuild_model_panel(st);
            false
        }
        KeyCode::Down if !tabs_focused => {
            let row_count = active_tab_clone
                .as_ref()
                .map(|t| t.rows.len())
                .unwrap_or(0);
            if row_count > 0 {
                let next = (body_cursor + 1).min(row_count.saturating_sub(1));
                st.model_panel_body_cursor = next;
            }
            rebuild_model_panel(st);
            false
        }
        KeyCode::Enter if !tabs_focused => {
            if let Some(tab) = active_tab_clone.as_ref() {
                let provider = tab.provider;
                match tab.rows.get(body_cursor) {
                    Some(ModelTabRow::Model { raw_id, .. }) => {
                        
                        let new_model = (*raw_id).to_string();
                        if let Err(e) = crate::state::broker::set_active_provider(
                            st,
                            provider,
                        ) {
                            tracing::warn!(?e, "/model commit: provider switch failed");
                        }
                        if let Err(e) = crate::state::broker::set_active_model(st, &new_model) {
                            tracing::warn!(?e, "/model commit: model flush failed");
                        }
                        if let Some(menu) = st.active_menu.take() {
                            let display =
                                crate::models::catalog::display_name_for(&new_model)
                                    .unwrap_or(new_model.as_str());
                            let anchor = format!("Set model to {display}");
                            st.push_anchor(
                                "model",
                                "",
                                anchor,
                                crate::tui::state::DisplayOrigin::Chrome,
                            );
                            let _ = menu;
                        }
                        return false;
                    }
                    Some(ModelTabRow::Logout) => {
                        st.pending_logout_provider = Some(provider);
                        st.active_menu = None;
                        return false;
                    }
                    Some(ModelTabRow::LoginCta) => {
                        st.pending_login_provider = Some(provider);
                        st.active_menu = None;
                        return false;
                    }
                    Some(ModelTabRow::CustomHint) => {
                        st.pending_login_provider = Some(provider);
                        st.active_menu = None;
                        return false;
                    }
                    None => {}
                }
            }
            false
        }
        _ => false,
    }
}

fn rebuild_model_panel(st: &mut ConversationState) {
    let fresh = menu::OverlayMenu::new_model_tabbed(
        &st.session.model,
        &st.persistence.settings,
        st.model_panel_tab_index,
        st.model_panel_tabs_focused,
        st.model_panel_body_cursor,
    );
    st.active_menu = Some(fresh);
}

fn commit_settings_row_enter(st: &mut ConversationState) {
    use crate::config::providers::{ProviderId, PROVIDER_ORDER};
    use crate::tui::menu::SettingsRowKind;
    let enter_kind = st
        .active_menu
        .as_ref()
        .and_then(|m| m.options.get(m.cursor))
        .and_then(|row| row.settings_kind.clone());
    if matches!(enter_kind, Some(SettingsRowKind::Model)) {
        let default_pid = st
            .persistence
            .settings
            .default_provider
            .as_deref()
            .and_then(ProviderId::from_slug)
            .unwrap_or(st.provider_id);
        st.model_panel_tab_index = PROVIDER_ORDER
            .iter()
            .position(|p| *p == default_pid)
            .unwrap_or(0);
        st.model_panel_tabs_focused = true;
        st.model_panel_body_cursor = 0;
        rebuild_model_panel(st);
    } else {
        edit_settings_row(st, 1);
    }
}

fn edit_settings_row(st: &mut ConversationState, direction: i32) {
    use crate::config::providers;
    use crate::config::settings::PermissionMode;
    use crate::tui::menu::SettingsRowKind;
    use crate::tui::slash::catalog::PanelKind;

    let (kind, tab) = {
        let Some(m) = st.active_menu.as_ref() else {
            return;
        };
        let tab = match m.kind {
            PanelKind::Settings(t) => t,
            _ => return,
        };
        let Some(row) = m.options.get(m.cursor) else {
            return;
        };
        let Some(kind) = row.settings_kind.clone() else {
            return;
        };
        (kind, tab)
    };

    let dir = if direction == 0 { 1 } else { direction.signum() };
    match kind {
        SettingsRowKind::Provider => {
            let current = st.provider_id;
            let next = providers::cycle(current, dir);
            if let Err(e) = crate::state::broker::set_active_provider(st, next) {
                tracing::warn!(?e, "/config provider cycle: broker commit failed");
            }
        }
        SettingsRowKind::Model => {
            let provider = st.provider_id;
            let list = crate::models::catalog::models_for(provider);
            if list.is_empty() {
                return;
            }
            let idx = list
                .iter()
                .position(|m| m.id == st.session.model.as_str())
                .unwrap_or(0);
            let n = list.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            let next_model = list[next_idx].id;
            if let Err(e) = crate::state::broker::set_active_model(st, next_model) {
                tracing::warn!(?e, "/config model cycle: broker write failed");
            }
            
            let current_effort = st.session.effort_label.unwrap_or("auto");
            if !crate::models::catalog::supports_effort(next_model, current_effort) {
                let next_effort = crate::models::catalog::default_effort_for(next_model);
                let thinking = crate::thinking::config_from_effort_label(next_effort);
                if let Err(e) = crate::state::broker::set_effort(
                    st,
                    thinking,
                    Some(next_effort.to_string()),
                ) {
                    tracing::warn!(?e, "/config model cycle: effort reset failed");
                }
            }
        }
        SettingsRowKind::PermissionMode => {
            let order = [
                PermissionMode::Default,
                PermissionMode::AcceptEdits,
                PermissionMode::Plan,
                PermissionMode::Yolo,
            ];
            let idx = order
                .iter()
                .position(|m| *m == st.session.permission_mode)
                .unwrap_or(0);
            let n = order.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            st.session.permission_mode = order[next_idx];
            crate::state::dispatch::set_permission_mode(st.session.permission_mode);

        }
        SettingsRowKind::Effort => {

            let levels: &[&str] = crate::models::catalog::by_id(&st.session.model)
                .map(|m| m.supported_efforts)
                .filter(|s| !s.is_empty())
                .unwrap_or(&["auto", "low", "medium", "high", "xhigh", "max"]);
            let current = st.session.effort_label.unwrap_or("auto");
            let idx = levels.iter().position(|l| *l == current).unwrap_or(0);
            let n = levels.len() as i32;
            let next_idx = (((idx as i32) + dir).rem_euclid(n)) as usize;
            let next_level = levels[next_idx];
            let thinking = crate::thinking::config_from_effort_label(next_level);
            if let Err(e) = crate::state::broker::set_effort(
                st,
                thinking,
                Some(next_level.to_string()),
            ) {
                tracing::warn!(?e, "/config effort cycle: broker write failed");
            }
        }
        SettingsRowKind::Bool(id) => {
            let current = match id {
                "auto_compact" => st.persistence.settings.auto_compact.unwrap_or(true),
                "show_tips" => st.persistence.settings.show_tips.unwrap_or(true),
                "verbose" => st.render_verbose,
                "prefers_reduced_motion" => st
                    .persistence
                    .settings
                    .prefers_reduced_motion
                    .unwrap_or(false),
                "file_checkpointing_enabled" => st
                    .persistence
                    .settings
                    .file_checkpointing_enabled
                    .unwrap_or(false),
                "auto_connect_ide" => {
                    st.persistence.settings.auto_connect_ide.unwrap_or(false)
                }
                "caveman_enabled" => {
                    st.persistence.settings.caveman_enabled.unwrap_or(true)
                }
                "rtk_enabled" => {
                    st.persistence.settings.rtk_enabled.unwrap_or(true)
                }
                _ => return,
            };
            let next = !current;
            if let Err(e) = crate::state::broker::set_bool_setting(st, id, next) {
                st.push_system_note(format!("settings write failed: {e}"));
            }
        }
        SettingsRowKind::ReadOnly => return,
    }

    let prev_cursor = st.active_menu.as_ref().map(|m| m.cursor).unwrap_or(0);
    let prev_header_focused = st
        .active_menu
        .as_ref()
        .and_then(|m| m.settings_header_focused)
        .unwrap_or(false);
    let prev_body_focused = st
        .active_menu
        .as_ref()
        .map(|m| m.settings_body_focused)
        .unwrap_or(false);
    let prev_search_query = st
        .active_menu
        .as_ref()
        .map(|m| m.settings_search_query.clone())
        .unwrap_or_default();
    st.active_menu = Some(menu::OverlayMenu::new_settings(tab, st));
    if let Some(m) = st.active_menu.as_mut() {
        m.cursor = prev_cursor.min(m.options.len().saturating_sub(1));
        m.settings_header_focused = Some(prev_header_focused);
        m.settings_body_focused = prev_body_focused;
        m.settings_search_query = prev_search_query;
    }
}

fn persist_session_defaults(st: &ConversationState) -> Result<()> {
    let mut pers = crate::state::PersistenceState::new(st.persistence.settings.clone());
    pers.commit_session_defaults(&st.session, st.provider_id.slug())
}

fn rotate_settings_tab(st: &mut ConversationState, direction: i32) {
    use crate::tui::slash::catalog::{PanelKind, SettingsTab};
    let current_tab = match st.active_menu.as_ref().map(|m| m.kind) {
        Some(PanelKind::Settings(t)) => t,
        _ => return,
    };
    let order = [SettingsTab::Status, SettingsTab::Config, SettingsTab::Usage];
    let idx = order.iter().position(|t| *t == current_tab).unwrap_or(0);
    let n = order.len() as i32;
    let next_idx = (((idx as i32) + direction).rem_euclid(n)) as usize;
    let next_tab = order[next_idx];

    use crate::tui::slash::panel;
    st.active_menu = None;
    let _ = panel::handle(PanelKind::Settings(next_tab), st);

    if let Some(m) = st.active_menu.as_mut() {
        m.settings_header_focused = Some(true);
    }
}

fn emit_panel_dismiss_anchor(
    st: &mut ConversationState,
    menu: &menu::OverlayMenu,
    outcome: Option<&menu::OverlayMenuOutcome>,
) {
    use crate::tui::slash::catalog::PanelKind;
    
    let (slash, text) = match (menu.kind, outcome) {
        (PanelKind::Permissions, Some(menu::OverlayMenuOutcome::SetPermissionMode { action_id })) => {
            ("permissions", format!("Set permission mode to {action_id}"))
        }
        (PanelKind::Effort, Some(menu::OverlayMenuOutcome::SetEffort { label, .. })) => {
            ("effort", format!("Set thinking effort to {label}"))
        }
        _ => return,
    };

    st.push_anchor(slash, "", text, DisplayOrigin::Chrome);
}

fn handle_paste(text: &str, st: &mut ConversationState) {
    if text.is_empty() {
        return;
    }
    if let Some(q) = st.pending_question.as_mut() {
        for c in text.chars() {
            q.push_char(c);
        }
        return;
    }
    if let Some(menu) = st.active_menu.as_mut() {
        
        if matches!(menu.kind, crate::tui::slash::catalog::PanelKind::Settings(_)) {
            menu.settings_search_query.push_str(text);
            return;
        }
    }
    
    let normalized: String = text.replace("\r\n", "\n").replace('\r', "\n");
    st.input_push_str(&normalized);
    st.refresh_autocomplete();
}

fn handle_question_key(k: KeyEvent, st: &mut ConversationState) {
    let Some(q) = st.pending_question.as_mut() else {
        return;
    };
    match k.code {
        KeyCode::Esc => {
            q.resolve(String::new());
            st.pending_question = None;
        }
        KeyCode::Enter => {
            let answer = std::mem::take(&mut q.input);
            q.resolve(answer);
            st.pending_question = None;
        }
        KeyCode::Backspace => q.backspace(),
        KeyCode::Char(c)
            if !k.modifiers.contains(KeyModifiers::CONTROL) =>
        {
            q.push_char(c);
        }
        _ => {}
    }
}

fn handle_agents_panel_key(k: KeyEvent, st: &mut ConversationState) {
    use slash::agents_panel::{handle_key, KeyOutcome};
    let Some(panel) = st.active_agents_panel.as_mut() else {
        return;
    };
    match handle_key(k, panel) {
        KeyOutcome::Dismiss => {
            
            st.active_agents_panel = None;
        }
        KeyOutcome::Consumed => {}
    }
}

fn handle_tasks_panel_key(k: KeyEvent, st: &mut ConversationState) {
    use slash::tasks_panel::{handle_key, KeyOutcome};
    let Some(panel) = st.active_tasks_panel.as_mut() else {
        return;
    };
    
    panel.refresh(&st.tasks);
    match handle_key(k, panel) {
        KeyOutcome::Dismiss => {
            
            st.active_tasks_panel = None;
        }
        KeyOutcome::StopFocused => {
            
            if let Some(tool_use_id) = panel
                .focused_row()
                .and_then(|r| r.tool_use_id.clone())
            {
                let _ = crate::tools::background_signal::signal(&tool_use_id);
            }
            
        }
        KeyOutcome::Consumed => {}
    }
}

fn handle_permission_key(k: KeyEvent, st: &mut ConversationState) {
    use crate::permissions::PermissionResponse;
    match k.code {
        KeyCode::Esc => {
            if let Some(mut prompt) = st.pending_permission.take() {
                prompt.resolve(PermissionResponse::Deny);
            }
        }
        KeyCode::Up => {
            if let Some(prompt) = st.pending_permission.as_mut() {
                prompt.move_up();
            }
        }
        KeyCode::Down => {
            if let Some(prompt) = st.pending_permission.as_mut() {
                prompt.move_down();
            }
        }
        KeyCode::Enter => {
            let Some(mut prompt) = st.pending_permission.take() else {
                return;
            };
            let response = prompt.selected_response();
            let rule = session_rule_for(&prompt.tool_name, &prompt.args_preview);
            match response {
                PermissionResponse::AllowSession => {
                    st.session_allowlist.push_rule(rule);
                }
                PermissionResponse::AllowAlways => {
                    st.session_allowlist.push_rule(rule.clone());
                    persist_permission_allow_rule(st, &rule);
                }
                _ => {}
            }
            prompt.resolve(response);
        }
        _ => {}
    }
}

fn persist_permission_allow_rule(st: &mut ConversationState, rule_str: &str) {
    use crate::config::settings::{PermissionRule, PermissionsConfig};
    use crate::permissions::{matcher, MatcherTool};
    let parsed = match matcher::parse(rule_str) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(?e, rule_str, "skip persist: rule unparseable");
            return;
        }
    };
    let tool_name = match parsed.tool {
        MatcherTool::Any => "*".to_string(),
        MatcherTool::Named(n) => n,
    };
    let new_rule = PermissionRule {
        tool_name: Some(tool_name.clone()),
        match_pattern: parsed.pattern.clone(),
        extra: Default::default(),
    };
    let perms = st
        .persistence
        .settings
        .permissions
        .get_or_insert_with(PermissionsConfig::default);
    let already = perms.allow.iter().any(|r| {
        r.tool_name.as_deref() == Some(tool_name.as_str())
            && r.match_pattern == parsed.pattern
    });
    if !already {
        perms.allow.push(new_rule);
    }
    if let Err(e) = persist_session_defaults(st) {
        tracing::warn!(?e, "persist permission rule failed");
    }
}

fn session_rule_for(tool_name: &str, args_preview: &str) -> String {
    if tool_name == "Bash" {
        let cmd = args_preview.trim();
        let prefix = cmd.split_whitespace().next().unwrap_or(cmd);
        if prefix.is_empty() {
            format!("{tool_name}(*)")
        } else {
            format!("{tool_name}({prefix}:*)")
        }
    } else {
        format!("{tool_name}(*)")
    }
}

fn apply_menu_outcome(
    st: &mut ConversationState,
    outcome: menu::OverlayMenuOutcome,
) -> bool {
    match outcome {
        menu::OverlayMenuOutcome::SetEffort { action_id, label } => {
            apply_effort_outcome(st, &action_id, &label);
        }
        menu::OverlayMenuOutcome::SetPermissionMode { action_id } => {
            apply_permission_outcome(st, &action_id);
        }
    }
    false
}

fn apply_permission_outcome(st: &mut ConversationState, action_id: &str) {
    use crate::config::settings::PermissionMode;
    let mode = match action_id {
        "default" => PermissionMode::Default,
        "acceptEdits" => PermissionMode::AcceptEdits,
        "plan" => PermissionMode::Plan,
        "yolo" => PermissionMode::Yolo,
        _ => {
            st.push_system_note(format!("unknown permission mode: {action_id}"));
            return;
        }
    };
    st.session.permission_mode = mode;
    crate::state::dispatch::set_permission_mode(mode);
}

fn apply_effort_outcome(
    st: &mut ConversationState,
    action_id: &str,
    label: &str,
) {
    use crate::thinking::ThinkingLevel;
    use std::str::FromStr;
    if action_id.eq_ignore_ascii_case("auto") {
        if let Err(e) = crate::state::broker::set_effort(
            st,
            Some(ThinkingConfig::auto()),
            Some("auto".to_string()),
        ) {
            st.push_system_note(format!("settings write failed: {e}"));
        }
        return;
    }
    match ThinkingLevel::from_str(action_id) {
        Ok(level) => {
            if let Err(e) = crate::state::broker::set_effort(
                st,
                Some(ThinkingConfig::level(level)),
                Some(action_id.to_string()),
            ) {
                st.push_system_note(format!("settings write failed: {e}"));
            }
        }
        Err(_) => {
            st.push_system_note(format!("unknown effort level: {action_id}"));
        }
    }
    let _ = label;
}

fn spawn_agent_turn(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    _base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
    history: Vec<crate::inference::OpenAiChatMessage>,
) {
    let provider_id = st.provider_id;
    let Some(provider) = registry.get(provider_id.slug()) else {
        
        st.push_anchor(
            "",
            "",
            format!(
                "provider {} not registered — cannot dispatch turn",
                provider_id.slug()
            ),
            crate::tui::state::DisplayOrigin::Chrome,
        );
        st.streaming = false;
        return;
    };

    let thinking = st.session.thinking;
    let tx = tx.clone();

    let model = st.session.model.clone();

    tracing::info!(
        target: "otherside::dispatch",
        provider = provider_id.slug(),
        model = %model,
        effort = %st.session.effort_label.unwrap_or("auto"),
        permission_mode = ?st.session.permission_mode,
        history_len = history.len(),
        "turn dispatched"
    );

    let settings = st.persistence.settings.clone();
    let mode = st.session.permission_mode;
    let session_allowlist = st.session_allowlist.clone();

    let handle = tokio::spawn(async move {
        run_agent_turns(
            provider,
            model,
            thinking,
            history,
            tx,
            settings,
            mode,
            session_allowlist,
            provider_id,
        )
        .await;
    });
    st.turn_task = Some(handle);
}

fn render_completion_line(r: &crate::tasks::TaskRecord) -> String {
    let kind_label = match r.kind {
        crate::tasks::TaskKind::Agent => "Agent",
        crate::tasks::TaskKind::Shell => "Background command",
        crate::tasks::TaskKind::Generic => "Background task",
    };
    let display_name: &str = if matches!(r.kind, crate::tasks::TaskKind::Agent) {
        r.description.as_deref().unwrap_or(r.name.as_str())
    } else {
        r.name.as_str()
    };
    let status_phrase = match r.state {
        crate::tasks::TaskState::Completed => "completed".to_string(),
        crate::tasks::TaskState::Failed => match r.error.as_deref() {
            Some(err) if !err.is_empty() => format!("failed: {err}"),
            _ => "failed".to_string(),
        },
        crate::tasks::TaskState::Stopped => "was stopped".to_string(),

        _ => "ended".to_string(),
    };
    let exit_suffix = r
        .exit_code
        .filter(|_| matches!(r.kind, crate::tasks::TaskKind::Shell))
        .map(|c| format!(" (exit code {c})"))
        .unwrap_or_default();
    if matches!(r.kind, crate::tasks::TaskKind::Agent) {
        format!("\u{25CF} {kind_label} \"{display_name}\" {status_phrase}{exit_suffix}")
    } else {
        format!("\u{25CF} {kind_label} \"{display_name}\" {status_phrase}{exit_suffix}")
    }
}

fn drain_pending_inputs(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    if auto_fire_compact_if_needed(st, registry, base_model, tx) {
        return true;
    }
    if drain_queue_head_if_any(st, registry, base_model, tx) {
        return true;
    }
    auto_trigger_pending_notifications(st, registry, base_model, tx)
}

fn auto_fire_compact_if_needed(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    if st.streaming {
        return false;
    }
    if !st.input.is_empty() {
        return false;
    }
    if !st.persistence.settings.auto_compact.unwrap_or(true) {
        return false;
    }
    if st.session.context_window == 0 {
        return false;
    }
    
    let threshold = st.session.context_window.saturating_sub(13_000);
    if threshold == 0 || st.input_tokens < threshold {
        return false;
    }
    if st.history_for_request().is_empty() {
        return false;
    }
    tracing::info!(
        target: "otherside::compact",
        input_tokens = st.input_tokens,
        threshold,
        "auto-fire: crossing auto-compact threshold, dispatching silent summary turn"
    );
    spawn_compact_turn(st, registry, base_model, tx, "", true);
    true
}

fn auto_trigger_pending_notifications(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    if st.streaming {
        return false;
    }
    if !st.input.is_empty() {
        return false;
    }
    let Some(store) = crate::tasks::store::current_global() else {
        return false;
    };
    if !store.has_pending_notifications() {
        return false;
    }
    let Some(history) = st.submit_auto_notification_turn(&store) else {
        return false;
    };
    tracing::info!(
        target: "otherside::queue",
        history_len = history.len(),
        "auto-trigger: notifications drained, dispatching synthetic turn"
    );
    spawn_agent_turn(st, registry, base_model, tx, history);
    true
}

fn drain_queue_head_if_any(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    tracing::info!(
        target: "otherside::queue",
        queue_depth = st.queued_messages.len(),
        streaming = st.streaming,
        "drain_queue_all entered"
    );
    
    if !st.consume_queue_all_into_input() {
        tracing::info!(target: "otherside::queue", "queue empty — no drain");
        return false;
    }
    tracing::info!(
        target: "otherside::queue",
        input_len = st.input.len(),
        streaming = st.streaming,
        "queue drained as batch; dispatching"
    );

    let exit_signal = dispatch_slash(st, registry, base_model, tx);
    tracing::info!(
        target: "otherside::queue",
        exit_signal,
        streaming_after = st.streaming,
        "dispatch_slash returned"
    );
    if exit_signal {
        st.push_system_note("queued /exit — press Ctrl+C twice to quit");
    }

    true
}

fn dispatch_slash(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    let action = slash::classify(&st.input);
    let outcome = match action {
        slash::SlashAction::Instant { name, args } => {
            slash::instant::handle(&name, &args, st)
        }
        slash::SlashAction::Toggle { name, args } => {
            slash::toggle::handle(&name, &args, st)
        }
        slash::SlashAction::Skill { name, args } => {
            slash::skill::handle(&name, &args, st)
        }
        slash::SlashAction::Anchor { name, args } if name == "compact" => {
            spawn_compact_turn(st, registry, base_model, tx, &args, false);
            slash::SlashOutcome::Handled
        }
        slash::SlashAction::Anchor { name, args } => {
            slash::anchor::handle(&name, &args, st)
        }
        slash::SlashAction::Panel(pk) => slash::panel::handle(pk, st),
        slash::SlashAction::Auth { name, args } => {
            slash::auth::handle(&name, &args, st)
        }
        slash::SlashAction::Unknown { name, args } => {
            let result = if args.is_empty() {
                format!("Unknown skill: {name}")
            } else {
                format!("Unknown skill: {name}\nArgs from unknown skill: {args}")
            };
            st.push_anchor(&name, &args, result, DisplayOrigin::Chrome);
            slash::SlashOutcome::Handled
        }
        slash::SlashAction::Passthrough => {
            submit_current_input(st, registry, base_model, tx);
            return false;
        }
    };

    match outcome {
        slash::SlashOutcome::Handled => {
            st.input.clear();
            st.autocomplete = None;
            false
        }
        slash::SlashOutcome::ExitApp => true,
        slash::SlashOutcome::SendTurn(body) => {

            let trimmed = st.input.trim();
            let echo = if trimmed.is_empty() {
                String::new()
            } else {
                trimmed.to_string()
            };
            st.pending_wire_override = Some(body);
            st.input = echo;
            submit_current_input(st, registry, base_model, tx);
            false
        }
        slash::SlashOutcome::ForkSkill { name, body } => {
            dispatch_forked_skill(st, &name, body);
            st.input.clear();
            st.autocomplete = None;
            false
        }
    }
}

fn refresh_fork_skill_anchor(st: &mut ConversationState) {
    let Some((anchor_idx, task_id)) = st.fork_skill_tracker.clone() else {
        return;
    };
    let Some(rec) = st.tasks.get(&task_id) else {
        return;
    };
    if anchor_idx >= st.messages.len() {
        st.fork_skill_tracker = None;
        return;
    }
    let runtime = rec.runtime_secs();
    let new_body = if rec.state.is_terminal() {
        let summary = rec
            .output
            .back()
            .cloned()
            .unwrap_or_else(|| "(no output)".to_string());
        let summary_trim: String = summary.chars().take(200).collect();
        let verdict = match rec.state {
            crate::tasks::TaskState::Completed => "completed",
            crate::tasks::TaskState::Failed => "failed",
            crate::tasks::TaskState::Stopped => "stopped",
            _ => "done",
        };
        format!(
            "⎿  /dream {verdict} · {tu} tool uses · {runtime}s\n   {summary_trim}",
            tu = rec.tool_uses,
        )
    } else {
        format!(
            "⎿  /dream running · {tu} tool uses · {runtime}s",
            tu = rec.tool_uses,
        )
    };
    st.messages[anchor_idx].content = new_body;
    if rec.state.is_terminal() {
        st.fork_skill_tracker = None;
    }
}

fn dispatch_forked_skill(st: &mut ConversationState, name: &str, body: String) {
    let anchor_id = format!("fork-{name}-{}", uuid::Uuid::new_v4());
    st.append_record(crate::sessions::Record::UserMessage {
        ts: crate::sessions::record::now_iso(),
        content: format!("/{name}"),
        provider: Some(st.provider_id.slug().to_string()),
        model: Some(st.session.model.clone()),
    });
    st.push_anchor(name, "", "Initializing…", DisplayOrigin::Chrome);
    let anchor_msg_idx = st.messages.len().saturating_sub(1);

    let definition = match crate::agent::subagents::registry::resolve("general-purpose") {
        Some(d) => d.clone(),
        None => {
            st.push_system_note("fork dispatch failed: general-purpose subagent missing");
            return;
        }
    };
    let runner = crate::agent::subagents::runner::InnerLoopRunner::new();
    let invocation = crate::agent::subagents::AgentInvocation::default();
    let outcome = crate::tasks::spawn_forked_skill_agent(
        runner,
        definition,
        body,
        invocation,
        st.tasks.clone(),
        format!("/{name}"),
        anchor_id.clone(),
    );
    st.fork_skill_tracker = Some((anchor_msg_idx, outcome.task_id));
}

fn submit_current_input(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
) {
    let submitted_text = st.input.clone();
    if let Some(history) = st.submit() {
        st.append_record(crate::sessions::Record::UserMessage {
            ts: crate::sessions::record::now_iso(),
            content: submitted_text,
            provider: Some(st.provider_id.slug().to_string()),
            model: Some(st.session.model.clone()),
        });
        spawn_agent_turn(st, registry, base_model, tx, history);
    }
}

fn spawn_compact_turn(
    st: &mut ConversationState,
    registry: &Arc<Registry>,
    _base_model: &str,
    tx: &mpsc::Sender<StreamEvent>,
    custom_instructions: &str,
    is_auto: bool,
) {
    let history = st.history_for_request();
    if history.is_empty() {
        st.push_system_note("⎿  compact skipped: no history to summarize");
        return;
    }

    let Some(provider) = registry.get(st.provider_id.slug()) else {
        st.push_system_note(format!(
            "compact skipped: provider {:?} not registered",
            st.provider_id.slug()
        ));
        return;
    };

    st.input.clear();
    st.autocomplete = None;
    st.streaming = true;
    st.compacting = true;

    let model = st.session.model.clone();
    let thinking_cfg = st.session.thinking;
    let tx = tx.clone();
    let custom = {
        let trimmed = custom_instructions.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    };

    tokio::spawn(async move {
        let result = crate::agent::compact::compact_conversation(
            &*provider,
            &model,
            history,
            custom.as_deref(),
            thinking_cfg,
        )
        .await;
        let event = match result {
            Ok(summary) => StreamEvent::CompactDone { summary, is_auto },
            Err(e) => StreamEvent::CompactFailed { message: e.to_string() },
        };
        let _ = tx.send(event).await;
    });
}

enum PickerOutcome {
    Resume(crate::sessions::SessionId),
    Latest,
    Fresh,
}

fn pick_session_pre_tui(
    cfg_dir: &std::path::Path,
    cwd: &std::path::Path,
) -> PickerOutcome {
    let sessions = match crate::sessions::list_for_cwd(cfg_dir, cwd) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("(otherside) listing sessions failed: {e} — starting fresh");
            return PickerOutcome::Fresh;
        }
    };
    if sessions.is_empty() {
        return PickerOutcome::Fresh;
    }
    if sessions.len() == 1 {
        return PickerOutcome::Resume(sessions[0].id.clone());
    }

    const MAX_ROWS: usize = 20;
    let shown = sessions.iter().take(MAX_ROWS).enumerate();

    eprintln!();
    eprintln!("Resume session — pick one for this directory:");
    for (idx, summary) in shown {
        let when = format_mtime_rel(summary.modified);
        let preview = summary
            .first_user_preview
            .as_deref()
            .unwrap_or("(no user messages yet)");
        let short_id = summary.id.to_string();
        let short = short_id.chars().take(8).collect::<String>();
        eprintln!("  [{:>2}] {when:<16} {short}  {preview}", idx + 1);
    }
    if sessions.len() > MAX_ROWS {
        eprintln!(
            "  … {} older sessions hidden — pass --resume <id> to resume by UUID.",
            sessions.len() - MAX_ROWS,
        );
    }
    eprintln!();
    eprint!("Enter number (1-{}), l=latest, n=fresh, q=quit [n]: ", sessions.len().min(MAX_ROWS));
    use std::io::Write;
    let _ = std::io::stderr().flush();

    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return PickerOutcome::Fresh;
    }
    let choice = line.trim();
    if choice.is_empty() || choice.eq_ignore_ascii_case("n") {
        return PickerOutcome::Fresh;
    }
    if choice.eq_ignore_ascii_case("q") {
        std::process::exit(0);
    }
    if choice.eq_ignore_ascii_case("l") {
        return PickerOutcome::Latest;
    }
    match choice.parse::<usize>() {
        Ok(n) if n >= 1 && n <= sessions.len().min(MAX_ROWS) => {
            PickerOutcome::Resume(sessions[n - 1].id.clone())
        }
        _ => {
            eprintln!("(otherside) unrecognized choice {choice:?} — starting fresh");
            PickerOutcome::Fresh
        }
    }
}

fn format_mtime_rel(mtime: std::time::SystemTime) -> String {
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(mtime)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match secs {
        0..=59 => "just now".to_string(),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3600),
        s if s < 2_592_000 => format!("{}d ago", s / 86_400),
        s => format!("{}w ago", s / 604_800),
    }
}

async fn run_agent_turns(
    provider: Arc<dyn Provider>,
    model: String,
    thinking: Option<ThinkingConfig>,
    initial_history: Vec<crate::inference::OpenAiChatMessage>,
    tx: mpsc::Sender<StreamEvent>,
    settings: crate::config::settings::Settings,
    mode: crate::config::settings::PermissionMode,
    session_allowlist: crate::permissions::RuntimePermissionGrants,
    provider_id: crate::config::providers::ProviderId,
) {
    use crate::agent::{AgentLoop, MAX_AUTO_TURNS};
    use agent_bridge::{TuiDispatcher, TuiObserver};

    let dispatcher = TuiDispatcher {
        tx: tx.clone(),
        settings: Arc::new(settings),
        mode,
        session_allowlist,
        provider_id,
    };
    let observer = TuiObserver { tx: tx.clone() };

    let loop_ = AgentLoop {
        model,
        thinking,
        max_turns: MAX_AUTO_TURNS,
        tools: crate::tools::openai_tools(),
        tool_choice: None,
        dispatcher,
        observer,
        cancel: None,
    };

    let provider = provider.clone();
    let _ = loop_
        .run(initial_history, |req, thinking_cfg| {
            let provider = provider.clone();
            async move { provider.stream(req, thinking_cfg).await }
        })
        .await;

    let _ = tx.send(StreamEvent::Done).await;
}

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    active: bool,
}

impl TerminalGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode().map_err(|e| Error::Tui(format!("raw mode: {e}")))?;
        let mut out = io::stdout();

        execute!(
            out,
            EnterAlternateScreen,
            EnableBracketedPaste
        )
        .map_err(|e| Error::Tui(format!("enter altscreen: {e}")))?;
        let backend = CrosstermBackend::new(out);
        let terminal = Terminal::new(backend)
            .map_err(|e| Error::Tui(format!("terminal init: {e}")))?;
        Ok(Self {
            terminal,
            active: true,
        })
    }

    fn restore(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;

        let _ = disable_raw_mode();
        let _ = execute!(
            self.terminal.backend_mut(),
            DisableBracketedPaste,
            LeaveAlternateScreen,
        );
        let _ = self.terminal.show_cursor();
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

#[cfg(test)]
mod panel_anchor_tests {
    
    use super::*;
    use crate::tui::menu::{OverlayMenu, OverlayMenuOutcome};
    use crate::tui::slash::catalog::PanelKind;

    fn decision_anchor(st: &ConversationState) -> (String, String) {
        let n = st.messages.len();
        assert!(
            n >= 2,
            "decision anchor pair expected; got {n} messages: {:?}",
            st.messages,
        );
        (
            st.messages[n - 2].content.clone(),
            st.messages[n - 1].content.clone(),
        )
    }

    #[test]
    fn every_panel_dismiss_without_outcome_is_silent() {
        use crate::tui::slash::catalog::SettingsTab;
        let mut st0 = ConversationState::default();
        st0.session.model = "claude-opus-4-7".into();
        let model_menu = OverlayMenu::new_model_tabbed(
            &st0.session.model,
            &st0.persistence.settings,
            0,
            true,
            0,
        );
        let permissions_menu = OverlayMenu::new_permissions(st0.session.permission_mode);
        let cases: Vec<(&str, OverlayMenu)> = vec![
            ("model", model_menu),
            ("tasks", OverlayMenu::new_info(PanelKind::Tasks, "Tasks".into(), vec![])),
            ("help", OverlayMenu::new_info(PanelKind::Help, "Help".into(), vec![])),
            ("permissions", permissions_menu),
            ("rewind", OverlayMenu::new_info(PanelKind::Rewind, "Rewind".into(), vec![])),
            ("resume", OverlayMenu::new_info(PanelKind::Resume, "Resume".into(), vec![])),
            ("effort", OverlayMenu::new_info(PanelKind::Effort, "Effort".into(), vec![])),
            ("status", OverlayMenu::new_info(PanelKind::Settings(SettingsTab::Status), "_".into(), vec![])),
            ("config", OverlayMenu::new_info(PanelKind::Settings(SettingsTab::Config), "_".into(), vec![])),
            ("usage", OverlayMenu::new_info(PanelKind::Settings(SettingsTab::Usage), "_".into(), vec![])),
        ];
        for (label, menu) in cases {
            let mut st = ConversationState::default();
            emit_panel_dismiss_anchor(&mut st, &menu, None);
            assert!(
                st.messages.is_empty(),
                "panel `{label}` dismiss must be silent; got {:?}",
                st.messages
            );
        }
    }

    #[test]
    fn permissions_dismiss_with_mode_change_emits_set() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_permissions(st.session.permission_mode);
        let outcome = OverlayMenuOutcome::SetPermissionMode {
            action_id: "plan".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = decision_anchor(&st);
        assert_eq!(anchor, "⎿  Set permission mode to plan");
    }

    #[test]
    fn effort_dismiss_with_level_change_emits_set() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_info(PanelKind::Effort, "Effort".into(), vec![]);
        let outcome = OverlayMenuOutcome::SetEffort {
            action_id: "high".into(),
            label: "high".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = decision_anchor(&st);
        assert_eq!(anchor, "⎿  Set thinking effort to high");
    }

    #[test]
    fn agents_panel_esc_is_silent() {
        use crate::agent::subagents::registry;
        use crate::tui::slash::agents_panel::AgentsPanelState;
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

        let mut st = ConversationState::default();
        st.active_agents_panel = Some(AgentsPanelState::new(&st.tasks, registry::all()));
        let esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        handle_agents_panel_key(esc, &mut st);

        assert!(st.active_agents_panel.is_none(), "panel closes on Esc");
        assert!(st.messages.is_empty(), "dismiss must be silent; got {:?}", st.messages);
    }

    #[test]
    fn decision_anchor_line_uses_double_space_after_symbol() {
        let mut st = ConversationState::default();
        let menu = OverlayMenu::new_permissions(st.session.permission_mode);
        let outcome = OverlayMenuOutcome::SetPermissionMode {
            action_id: "yolo".into(),
        };
        emit_panel_dismiss_anchor(&mut st, &menu, Some(&outcome));
        let (_, anchor) = decision_anchor(&st);
        assert!(anchor.starts_with("⎿  "), "got {anchor:?}");
        let bytes = anchor.as_bytes();
        assert_eq!(&bytes[0..3], [0xE2, 0x8E, 0xBF]);
        assert_eq!(bytes[3], b' ');
        assert_eq!(bytes[4], b' ');
        assert_ne!(bytes[5], b' ');
    }
}

#[cfg(test)]
mod settings_edit_tests {
    use super::*;
    use crate::config::settings::PermissionMode;
    use crate::tui::menu::OverlayMenu;
    use crate::tui::slash::catalog::SettingsTab;

    fn focus_row(menu: &mut OverlayMenu, label: &str) {
        menu.cursor = menu
            .options
            .iter()
            .position(|o| o.label == label)
            .unwrap_or_else(|| panic!("row {label:?} missing from Settings Config tab"));
        menu.settings_header_focused = Some(false);
    }

    #[test]
    fn provider_row_cycles_and_switches_model_default() {
        use crate::config::providers::ProviderId;

        let mut st = ConversationState::default();
        st.session.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Provider");
        }

        edit_settings_row(&mut st, 1);
        assert_eq!(st.provider_id, ProviderId::Codex);
        assert_eq!(st.persistence.settings.default_provider.as_deref(), Some("codex-oauth"));
        assert_eq!(st.session.model, "gpt-5.4");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("gemini-oauth")
        );
        assert_eq!(st.session.model, "gemini-3-pro-preview");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("kimi")
        );
        assert_eq!(st.session.model, "kimi-for-coding");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("openai-custom")
        );

        assert_eq!(st.session.model, "gpt-5.5");

        edit_settings_row(&mut st, 1);
        assert_eq!(
            st.persistence.settings.default_provider.as_deref(),
            Some("anthropic-oauth")
        );
        assert_eq!(st.session.model, "claude-opus-4-7[1m]");
    }

    #[test]
    fn effort_row_reflects_new_provider_after_switch() {
        
        use crate::config::providers::ProviderId;
        use crate::config::settings::PermissionMode;

        let mut st = ConversationState::default();
        st.session.permission_mode = PermissionMode::Default;
        st.session.model = "claude-opus-4-7[1m]".into();
        st.provider_id = ProviderId::ClaudeCode;

        let claude_efforts = crate::models::catalog::by_id(&st.session.model)
            .map(|m| m.supported_efforts)
            .unwrap();
        assert!(
            claude_efforts.len() > 1,
            "precondition: opus exposes multi-level effort; got {claude_efforts:?}"
        );

        st.switch_provider(ProviderId::Kimi);
        assert_eq!(st.session.model, "kimi-for-coding");

        let kimi_efforts = crate::models::catalog::by_id(&st.session.model)
            .map(|m| m.supported_efforts)
            .unwrap();
        assert_eq!(
            kimi_efforts,
            &["on", "off"],
            "Kimi reasoning is binary on/off post 2026-04-22 catalog reshape; got {kimi_efforts:?}"
        );

        st.session.effort_label = None;
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Thinking");
        }
        edit_settings_row(&mut st, 1);
        assert!(
            matches!(st.session.effort_label, Some("on") | Some("off")),
            "Kimi effort cycle must land on one of on/off; got {:?}",
            st.session.effort_label
        );
    }

    #[test]
    fn config_tab_hides_fast_mode_for_anthropic() {
        use crate::config::providers::ProviderId;

        let mut st = ConversationState::default();
        st.provider_id = ProviderId::ClaudeCode;
        st.persistence.settings.default_provider = Some("anthropic-oauth".into());
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        let labels: Vec<String> = st
            .active_menu
            .as_ref()
            .unwrap()
            .options
            .iter()
            .map(|o| o.label.clone())
            .collect();
        assert!(
            !labels.iter().any(|l| l == "Fast mode"),
            "Fast mode must be hidden on anthropic — /v1/messages rejects service_tier:fast; got {labels:?}"
        );
    }

    #[test]
    fn config_tab_hides_fast_mode_and_effort_for_kimi_shows_thinking() {
        use crate::config::providers::ProviderId;

        let mut st = ConversationState::default();
        st.provider_id = ProviderId::Kimi;
        st.persistence.settings.default_provider = Some("kimi".into());
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        let labels: Vec<String> = st
            .active_menu
            .as_ref()
            .unwrap()
            .options
            .iter()
            .map(|o| o.label.clone())
            .collect();
        assert!(
            !labels.iter().any(|l| l == "Fast mode"),
            "Fast mode must be hidden on Kimi Code; got {labels:?}"
        );
        assert!(
            !labels.iter().any(|l| l == "Effort"),
            "Effort must be hidden on Kimi Code — it uses binary Thinking on/off instead; got {labels:?}"
        );
        assert!(
            labels.iter().any(|l| l == "Thinking"),
            "Kimi Code must surface the Thinking row; got {labels:?}"
        );
    }

    #[test]
    fn config_tab_shows_fast_mode_for_codex() {
        use crate::config::providers::ProviderId;

        let mut st = ConversationState::default();
        st.provider_id = ProviderId::Codex;
        st.persistence.settings.default_provider = Some("codex-oauth".into());
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        let labels: Vec<String> = st
            .active_menu
            .as_ref()
            .unwrap()
            .options
            .iter()
            .map(|o| o.label.clone())
            .collect();
        assert!(
            labels.iter().any(|l| l == "Fast mode"),
            "Fast mode must be visible on Codex — /responses supports service_tier:fast; got {labels:?}"
        );
    }

    #[test]
    fn paste_event_injects_into_prompt_as_one_blob() {
        let mut st = ConversationState::default();
        super::handle_paste("hello\r\nworld\n!", &mut st);
        assert_eq!(
            st.input, "hello\nworld\n!",
            "CRLF must normalize to LF so multi-line pastes stay well-formed"
        );
    }

    #[test]
    fn paste_image_file_path_injects_as_plain_text_not_stripped() {
        
        let mut st = ConversationState::default();
        super::handle_paste("/Users/me/Desktop/screenshot.png", &mut st);
        assert_eq!(st.input, "/Users/me/Desktop/screenshot.png");

        let mut st2 = ConversationState::default();
        super::handle_paste(
            "file:///Users/me/Downloads/capture.jpeg",
            &mut st2,
        );
        assert_eq!(st2.input, "file:///Users/me/Downloads/capture.jpeg");
    }

    #[test]
    fn paste_empty_string_is_noop() {
        let mut st = ConversationState::default();
        st.input = "keep me".to_string();
        super::handle_paste("", &mut st);
        assert_eq!(st.input, "keep me");
    }

    #[test]
    fn paste_into_settings_panel_extends_search_query_not_prompt() {
        use crate::tui::menu::OverlayMenu;
        use crate::tui::slash::catalog::SettingsTab;
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        super::handle_paste("permiss", &mut st);
        let menu = st.active_menu.as_ref().unwrap();
        assert_eq!(menu.settings_search_query, "permiss");
        assert_eq!(st.input, "", "prompt must stay untouched while settings panel absorbs paste");
    }

    #[test]
    fn permission_mode_row_cycles_through_four_modes() {
        let mut st = ConversationState::default();
        st.session.permission_mode = PermissionMode::Default;
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Default permission mode");
        }

        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.permission_mode, PermissionMode::AcceptEdits);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.permission_mode, PermissionMode::Plan);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.permission_mode, PermissionMode::Yolo);
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.permission_mode, PermissionMode::Default);
    }

    #[test]
    fn effort_row_cycles_through_six_levels() {
        let mut st = ConversationState::default();
        st.session.effort_label = Some("auto");
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Effort");
        }
        
        const EXPECTED: &[Option<&str>] = &[
            Some("low"),
            Some("medium"),
            Some("high"),
            Some("xhigh"),
            Some("max"),
            None,
        ];
        for want in EXPECTED {
            edit_settings_row(&mut st, 1);
            assert_eq!(st.session.effort_label, *want);
        }
        assert_eq!(st.persistence.settings.effort_level.as_deref(), Some("auto"));
    }

    #[test]
    fn verbose_row_toggles_on_space() {
        let mut st = ConversationState::default();
        st.render_verbose = false;
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Verbose output");
        }
        edit_settings_row(&mut st, 1);
        assert!(st.render_verbose);
        assert_eq!(st.persistence.settings.verbose, Some(true));
        edit_settings_row(&mut st, 1);
        assert!(!st.render_verbose);
        assert_eq!(st.persistence.settings.verbose, Some(false));
    }

    #[test]
    fn model_row_cycles_through_provider_aliases() {
        let mut st = ConversationState::default();
        st.persistence.settings.default_provider = Some("claude-code".into());
        st.session.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Model");
        }
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.model, "claude-opus-4-7");
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.model, "claude-sonnet-4-6");
        edit_settings_row(&mut st, -1);
        assert_eq!(st.session.model, "claude-opus-4-7");
    }

    #[test]
    fn enter_on_model_row_opens_model_panel_instead_of_cycling() {
        use crate::tui::slash::catalog::PanelKind;
        let mut st = ConversationState::default();
        st.persistence.settings.default_provider = Some("claude-code".into());
        st.session.model = "claude-opus-4-7[1m]".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Model");
        }
        commit_settings_row_enter(&mut st);
        assert_eq!(
            st.session.model, "claude-opus-4-7[1m]",
            "session model must not mutate — Enter must open picker, not cycle"
        );
        let kind = st
            .active_menu
            .as_ref()
            .expect("menu still present")
            .kind;
        assert!(
            matches!(kind, PanelKind::Model),
            "Enter must switch overlay to /model panel, got {kind:?}"
        );
    }

    #[test]
    fn enter_on_bool_row_still_toggles() {
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Auto-compact");
        }
        let before = st.persistence.settings.auto_compact.unwrap_or(true);
        commit_settings_row_enter(&mut st);
        let after = st
            .persistence
            .settings
            .auto_compact
            .expect("bool setting persists");
        assert_eq!(after, !before, "non-Model Enter must still cycle");
    }

    #[test]
    fn read_only_row_is_a_no_op() {

        let mut st = ConversationState::default();
        st.session.model = "claude-opus-4-7".into();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Status, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Model");
        }
        let snap = st.session.model.clone();
        edit_settings_row(&mut st, 1);
        assert_eq!(st.session.model, snap);
    }

    #[test]
    fn edit_preserves_body_focus_and_search_query() {
        
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            m.settings_body_focused = true;
            m.settings_search_query = "auto".into();
            focus_row(m, "Auto-compact");
        }
        let cursor_before = st.active_menu.as_ref().unwrap().cursor;
        edit_settings_row(&mut st, 1);
        let m = st.active_menu.as_ref().expect("menu still present");
        assert!(
            m.settings_body_focused,
            "body focus must survive edit — user bug 2026-04-23"
        );
        assert_eq!(
            m.settings_search_query, "auto",
            "search query must survive edit"
        );
        assert_eq!(
            m.cursor, cursor_before,
            "cursor row must not jump on edit"
        );
    }

    #[test]
    fn enter_on_caveman_row_toggles_and_persists() {
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "Caveman");
        }
        let before = st.persistence.settings.caveman_enabled.unwrap_or(true);
        commit_settings_row_enter(&mut st);
        let after = st
            .persistence
            .settings
            .caveman_enabled
            .expect("caveman_enabled must persist after toggle");
        assert_eq!(after, !before, "Enter on Caveman row must flip the flag");

        let rebuilt = st
            .active_menu
            .as_ref()
            .and_then(|m| m.options.iter().find(|o| o.label == "Caveman"))
            .expect("Caveman row survives rebuild");
        assert_eq!(
            rebuilt.value_display.as_deref(),
            Some(if after { "true" } else { "false" }),
            "live overlay must reflect the new value without restart",
        );
    }

    #[test]
    fn enter_on_rtk_row_toggles_and_persists() {
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));
        if let Some(m) = st.active_menu.as_mut() {
            focus_row(m, "RTK");
        }
        let before = st.persistence.settings.rtk_enabled.unwrap_or(true);
        commit_settings_row_enter(&mut st);
        let after = st
            .persistence
            .settings
            .rtk_enabled
            .expect("rtk_enabled must persist after toggle");
        assert_eq!(after, !before, "Enter on RTK row must flip the flag");
    }

    #[test]
    fn every_bool_row_toggles_its_settings_field() {
        let mut st = ConversationState::default();
        st.active_menu = Some(OverlayMenu::new_settings(SettingsTab::Config, &st));

        type Getter = fn(&ConversationState) -> Option<bool>;
        let rows: &[(&str, Getter)] = &[
            ("Auto-compact", |s| s.persistence.settings.auto_compact),
            ("Show tips", |s| s.persistence.settings.show_tips),
            ("Caveman", |s| s.persistence.settings.caveman_enabled),
            ("RTK", |s| s.persistence.settings.rtk_enabled),
        ];
        for (label, getter) in rows {
            if let Some(m) = st.active_menu.as_mut() {
                focus_row(m, label);
            }
            let before = getter(&st).unwrap_or(true);
            edit_settings_row(&mut st, 1);
            let after = getter(&st).expect("bool setting must persist");
            assert_eq!(after, !before, "row {label} failed to toggle");
        }
    }
}
