

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use futures::{future::BoxFuture, stream::BoxStream};

use crate::error::Result;
use crate::inference::{OpenAiChatRequest, OpenAiChunk};
use crate::thinking::ThinkingConfig;

pub mod anthropic;
pub mod codex;
pub mod codex_models;
pub mod kimi;
pub mod kimi_models;

pub type ChunkStream = BoxStream<'static, Result<OpenAiChunk>>;

pub trait Provider: Send + Sync {

    fn stream<'a>(
        &'a self,
        req: OpenAiChatRequest,
        thinking: Option<ThinkingConfig>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<ChunkStream>> + Send + 'a>>;

    fn id(&self) -> &'static str;
}

#[allow(dead_code)]
pub type ProviderFuture<'a, T> = BoxFuture<'a, Result<T>>;

#[derive(Default)]
pub struct Registry {
    by_id: HashMap<&'static str, Arc<dyn Provider>>,
}

impl Registry {

    pub fn builder() -> RegistryBuilder {
        RegistryBuilder {
            by_id: HashMap::new(),
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.by_id.get(id).cloned()
    }

    pub fn ids(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.by_id.keys().copied()
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }
}

pub struct RegistryBuilder {
    by_id: HashMap<&'static str, Arc<dyn Provider>>,
}

impl RegistryBuilder {

    pub fn with(mut self, p: Arc<dyn Provider>) -> Self {
        let id = p.id();
        self.by_id.insert(id, p);
        self
    }

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
