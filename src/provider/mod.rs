//! Provider trait + registry + per-provider implementations.
//!
//! # Trait
//!
//! A provider exposes a single async streaming method: given a canonical
//! OpenAI-shaped request, return a stream of canonical OpenAI-shaped events.
//!
//! We use manual `BoxFuture` / `BoxStream` (from `futures`) rather than the
//! `async_trait` crate so we don't pull a proc-macro dep and so the trait
//! is object-safe for `Arc<dyn Provider>` dispatch. Rust's native
//! `async fn` in traits is stable since 1.75 but not yet dyn-compatible.
//!
//! # Registry
//!
//! The provider registry is built at startup by `config::load()` + the
//! per-provider factories. It maps stable provider IDs to `Arc<dyn Provider>`
//! trait objects. Agents ask for a provider by ID and never touch the
//! concrete type.
//!
//! # Per-provider impls
//!
//! Each provider is a sibling module:
//! - `anthropic` (MVP — `anthropic-oauth`)
//! - (post-MVP) `codex`, `gemini`, `openai_compatible`
//!
//! Each impl:
//! - Owns its reqwest client (preconfigured with zstd/brotli/gzip).
//! - Accesses `auth::<provider>` for bearer tokens.
//! - Calls translators from `src/translator/<source>/<target>/`.
//! - Sets fingerprint headers from `src/fingerprint/<provider>`.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use futures::{future::BoxFuture, stream::BoxStream};

use crate::error::Result;
use crate::inference::{OpenAiChatRequest, OpenAiChunk};
use crate::thinking::ThinkingConfig;

pub mod anthropic;

/// Inference streaming is a stream of either a chunk or an error. An
/// error mid-stream terminates the stream.
pub type ChunkStream = BoxStream<'static, Result<OpenAiChunk>>;

/// Abstraction over an inference backend.
///
/// The single method [`stream`](Provider::stream) returns a future that
/// resolves to a stream of chunks. The double indirection (future →
/// stream) reflects that some providers (the real one in particular) need
/// an async round-trip to open the HTTP connection before streaming can
/// begin.
///
/// Trait is `Send + Sync` so providers can live in an `Arc<dyn Provider>`
/// and be shared across tokio tasks. `'static` on the returned boxes
/// means the stream can outlive the caller.
pub trait Provider: Send + Sync {
    /// Run inference against this provider.
    ///
    /// - `req` is the canonical OpenAI-shaped request.
    /// - `thinking` is the effective thinking config resolved from the
    ///   model-name suffix or the request body (suffix wins per C12).
    fn stream<'a>(
        &'a self,
        req: OpenAiChatRequest,
        thinking: Option<ThinkingConfig>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>>;

    /// Short stable identifier for the provider (e.g. `"anthropic-oauth"`).
    fn id(&self) -> &'static str;
}

// Alias for consumers that want to write the return type more naturally.
// Uses `BoxFuture` from `futures` to save keystrokes vs the manual
// `Pin<Box<dyn Future + Send>>` used in the trait signature above.
// Keeping both forms — the trait uses the desugared version to stay
// dyn-compatible without relying on crate implementation details.
#[allow(dead_code)]
pub type ProviderFuture<'a, T> = BoxFuture<'a, Result<T>>;

/// Runtime registry mapping provider IDs to trait objects.
///
/// Build via [`Registry::builder`] at startup; then share via `Arc` and
/// look up by ID.
#[derive(Default)]
pub struct Registry {
    by_id: HashMap<&'static str, Arc<dyn Provider>>,
}

impl Registry {
    /// Start a registry builder with zero providers registered.
    pub fn builder() -> RegistryBuilder {
        RegistryBuilder {
            by_id: HashMap::new(),
        }
    }

    /// Look up a provider by stable ID.
    pub fn get(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.by_id.get(id).cloned()
    }

    /// List registered provider IDs (stable string keys).
    pub fn ids(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.by_id.keys().copied()
    }

    /// Number of registered providers.
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    /// `true` when no provider is registered.
    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }
}

/// Fluent builder for [`Registry`].
pub struct RegistryBuilder {
    by_id: HashMap<&'static str, Arc<dyn Provider>>,
}

impl RegistryBuilder {
    /// Register a provider. Uses the provider's own `id()` as the key.
    pub fn with(mut self, p: Arc<dyn Provider>) -> Self {
        let id = p.id();
        self.by_id.insert(id, p);
        self
    }

    /// Finalize into an immutable [`Registry`].
    pub fn build(self) -> Registry {
        Registry { by_id: self.by_id }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;

    struct StubProvider;

    impl Provider for StubProvider {
        fn id(&self) -> &'static str {
            "stub"
        }

        fn stream<'a>(
            &'a self,
            _req: OpenAiChatRequest,
            _thinking: Option<ThinkingConfig>,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>>
        {
            Box::pin(async move {
                let s: ChunkStream = Box::pin(stream::empty());
                Ok(s)
            })
        }
    }

    #[test]
    fn registry_round_trip() {
        let reg = Registry::builder().with(Arc::new(StubProvider)).build();
        assert_eq!(reg.len(), 1);
        assert!(reg.get("stub").is_some());
        assert!(reg.get("unknown").is_none());
    }

    #[tokio::test]
    async fn stub_provider_streams() {
        let reg = Registry::builder().with(Arc::new(StubProvider)).build();
        let p = reg.get("stub").unwrap();
        let req = OpenAiChatRequest {
            model: "m".to_string(),
            stream: Some(true),
            ..Default::default()
        };
        let mut s = p.stream(req, None).await.unwrap();
        use futures::StreamExt;
        assert!(s.next().await.is_none());
    }
}
