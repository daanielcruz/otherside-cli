

use otherside::config::providers::{ProviderId, PROVIDER_ORDER};
use otherside::provider::{
    anthropic::AnthropicProvider, codex::CodexProvider, kimi::KimiProvider, Registry,
};

#[test]
fn kimi_provider_registers_and_resolves_through_slug() {
    let registry = Registry::builder()
        .with(AnthropicProvider::arc().expect("anthropic builds"))
        .with(CodexProvider::arc().expect("codex builds"))
        .with(KimiProvider::arc().expect("kimi builds"))
        .build();

    assert_eq!(registry.len(), 3);
    assert!(registry.get("kimi").is_some());

    assert!(registry.get("anthropic-oauth").is_some());
    // CodexProvider::ID is now "codex-oauth" to match ProviderId::Codex.slug()
    // (turn-dispatch registry lookup). Legacy "codex" short form is resolved
    // at config::providers::from_slug parse time only.
    assert!(registry.get("codex-oauth").is_some());
}

#[test]
fn kimi_slug_and_aliases_all_resolve_to_same_variant() {

    assert_eq!(ProviderId::from_slug("kimi"), Some(ProviderId::Kimi));
    assert_eq!(ProviderId::from_slug("kimi-code"), Some(ProviderId::Kimi));
    assert_eq!(ProviderId::from_slug("moonshot"), Some(ProviderId::Kimi));
    assert_eq!(ProviderId::Kimi.slug(), "kimi");
}

#[test]
fn kimi_sits_between_gemini_and_openai_custom_in_cycle() {

    let gemini_idx = PROVIDER_ORDER
        .iter()
        .position(|p| *p == ProviderId::GeminiCli)
        .unwrap();
    let kimi_idx = PROVIDER_ORDER
        .iter()
        .position(|p| *p == ProviderId::Kimi)
        .unwrap();
    let openai_idx = PROVIDER_ORDER
        .iter()
        .position(|p| *p == ProviderId::OpenAiCustom)
        .unwrap();
    assert_eq!(kimi_idx, gemini_idx + 1);
    assert_eq!(openai_idx, kimi_idx + 1);
}

#[test]
fn kimi_default_model_is_for_coding() {
    assert_eq!(ProviderId::Kimi.default_model(), "kimi-for-coding");
}

#[test]
fn kimi_catalog_carries_two_rows_both_at_262k() {
    use otherside::models::catalog;
    let ms = catalog::models_for(ProviderId::Kimi);
    assert_eq!(ms.len(), 1, "live probe 2026-04-22 returned one row");
    for m in &ms {
        assert_eq!(m.context_window, 262_144);
        assert!(!m.supports_1m);
    }

    assert!(ms.iter().any(|m| m.id == "kimi-for-coding"));
    assert!(
        !ms.iter().any(|m| m.id == "kimi-k2-thinking"),
        "kimi-k2-thinking is a ghost — backend rejects the slug"
    );
}

#[test]
fn kimi_provider_label_is_user_readable() {
    assert_eq!(ProviderId::Kimi.label(), "Kimi (API Key)");
}
