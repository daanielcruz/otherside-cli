
use std::sync::{Arc, OnceLock, RwLock};

use crate::provider::{Provider, Registry};
use crate::thinking::ThinkingConfig;

#[derive(Clone)]
pub struct DispatchSnapshot {
    pub provider: Arc<dyn Provider>,
    pub model: String,
    pub thinking: Option<ThinkingConfig>,
}

static SNAPSHOT: OnceLock<Arc<RwLock<DispatchSnapshot>>> = OnceLock::new();
static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();

pub fn install(snapshot: DispatchSnapshot) -> bool {
    SNAPSHOT.set(Arc::new(RwLock::new(snapshot))).is_ok()
}

pub fn install_registry(registry: Arc<Registry>) -> bool {
    REGISTRY.set(registry).is_ok()
}

pub fn provider_by_slug(slug: &str) -> Option<Arc<dyn Provider>> {
    REGISTRY.get().and_then(|r| r.get(slug))
}

pub fn snapshot() -> Option<DispatchSnapshot> {
    SNAPSHOT
        .get()
        .map(|lock| lock.read().expect("dispatch snapshot lock poisoned").clone())
}

pub(crate) fn set_provider(provider: Arc<dyn Provider>) {
    if let Some(lock) = SNAPSHOT.get() {
        lock.write().expect("dispatch snapshot lock poisoned").provider = provider;
    }
}

pub(crate) fn set_model(model: String) {
    if let Some(lock) = SNAPSHOT.get() {
        lock.write().expect("dispatch snapshot lock poisoned").model = model;
    }
}

pub(crate) fn set_thinking(thinking: Option<ThinkingConfig>) {
    if let Some(lock) = SNAPSHOT.get() {
        lock.write()
            .expect("dispatch snapshot lock poisoned")
            .thinking = thinking;
    }
}

#[cfg(test)]
pub(crate) fn install_for_test(snapshot: DispatchSnapshot) {
    
    if let Some(lock) = SNAPSHOT.get() {
        *lock.write().expect("dispatch snapshot lock poisoned") = snapshot;
    } else {
        let _ = SNAPSHOT.set(Arc::new(RwLock::new(snapshot)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Result as CrateResult;
    use crate::inference::OpenAiChatRequest;
    use crate::provider::ChunkStream;
    use crate::thinking::{ThinkingConfig, ThinkingLevel};
    use futures::stream;
    use std::pin::Pin;

    struct FakeProvider(&'static str);

    impl Provider for FakeProvider {
        fn id(&self) -> &'static str {
            self.0
        }

        fn stream<'a>(
            &'a self,
            _req: OpenAiChatRequest,
            _thinking: Option<ThinkingConfig>,
        ) -> Pin<Box<dyn std::future::Future<Output = CrateResult<ChunkStream>> + Send + 'a>>
        {
            Box::pin(async move {
                let s: ChunkStream = Box::pin(stream::empty());
                Ok(s)
            })
        }
    }

    #[test]
    fn snapshot_round_trips_install_and_read() {
        install_for_test(DispatchSnapshot {
            provider: Arc::new(FakeProvider("stub-a")) as Arc<dyn Provider>,
            model: "m-a".into(),
            thinking: None,
        });
        let snap = snapshot().expect("snapshot present after install");
        assert_eq!(snap.provider.id(), "stub-a");
        assert_eq!(snap.model, "m-a");
        assert!(snap.thinking.is_none());
    }

    #[test]
    fn writers_mutate_snapshot_fields_independently() {
        install_for_test(DispatchSnapshot {
            provider: Arc::new(FakeProvider("before")) as Arc<dyn Provider>,
            model: "before-model".into(),
            thinking: None,
        });

        set_provider(Arc::new(FakeProvider("after")) as Arc<dyn Provider>);
        set_model("after-model".into());
        set_thinking(Some(ThinkingConfig::level(ThinkingLevel::High)));

        let snap = snapshot().expect("snapshot present");
        assert_eq!(snap.provider.id(), "after");
        assert_eq!(snap.model, "after-model");
        assert_eq!(
            snap.thinking.map(|t| t.level),
            Some(ThinkingLevel::High),
            "thinking writer landed"
        );
    }
}
