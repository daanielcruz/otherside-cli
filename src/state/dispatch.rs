//! `state::dispatch` — single source-of-truth snapshot for the subagent
//! runner (and any other dispatch site that can't hold a `ConversationState`
//! reference).
//!
//! Problem it fixes: `InnerLoopRunner` historically cached `(provider,
//! default_model)` at boot and hard-coded `thinking: None`. When the user
//! switched provider / model / effort mid-session via the UI, the runner
//! happily kept dispatching against the boot capture. Parent turns updated;
//! subagent turns drifted.
//!
//! Shape: global `Arc<RwLock<DispatchSnapshot>>`. UI mutations land through
//! `state::broker::*`, which is the **only** module allowed to call the
//! `pub(crate) set_*` writers here. Reads are `pub`, so the runner (and the
//! compact path, and anywhere else that dispatches outside the TUI thread)
//! can snapshot live values.
//!
//! Two-SoT discipline: `ConversationState` remains authoritative for UI
//! rendering. `DispatchSnapshot` mirrors the subset dispatch needs. Broker
//! writes BOTH in lock-step so the two never diverge.

use std::sync::{Arc, OnceLock, RwLock};

use crate::provider::{Provider, Registry};
use crate::thinking::ThinkingConfig;

/// Subset of `ConversationState` that the dispatch hot path needs. Cheap to
/// clone (one `Arc` + a `String` + a `Copy` thinking config).
#[derive(Clone)]
pub struct DispatchSnapshot {
    pub provider: Arc<dyn Provider>,
    pub model: String,
    pub thinking: Option<ThinkingConfig>,
}

static SNAPSHOT: OnceLock<Arc<RwLock<DispatchSnapshot>>> = OnceLock::new();
static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();

/// Install the initial snapshot at boot. Returns `false` if a snapshot was
/// already installed (subsequent boots in the same process — tests).
pub fn install(snapshot: DispatchSnapshot) -> bool {
    SNAPSHOT.set(Arc::new(RwLock::new(snapshot))).is_ok()
}

/// Install the provider registry at boot. Needed so broker-level provider
/// swaps can resolve `ProviderId → Arc<dyn Provider>` without threading the
/// registry through every caller (there are two: `/model` panel Enter and
/// `/config` Provider cycle; the latter's call chain had ~20 test sites).
pub fn install_registry(registry: Arc<Registry>) -> bool {
    REGISTRY.set(registry).is_ok()
}

/// Look up a provider by slug in the installed registry. Returns `None` if
/// no registry was installed (test harness) or the slug is unregistered.
pub fn provider_by_slug(slug: &str) -> Option<Arc<dyn Provider>> {
    REGISTRY.get().and_then(|r| r.get(slug))
}

/// Live read of the current snapshot. Returns `None` when boot hasn't
/// finished installing (test harnesses, service mode without a runner).
pub fn snapshot() -> Option<DispatchSnapshot> {
    SNAPSHOT
        .get()
        .map(|lock| lock.read().expect("dispatch snapshot lock poisoned").clone())
}

/// Broker-only writer. Swaps the provider the runner will dispatch against.
pub(crate) fn set_provider(provider: Arc<dyn Provider>) {
    if let Some(lock) = SNAPSHOT.get() {
        lock.write().expect("dispatch snapshot lock poisoned").provider = provider;
    }
}

/// Broker-only writer. Swaps the model the runner will default to when the
/// caller doesn't pin one.
pub(crate) fn set_model(model: String) {
    if let Some(lock) = SNAPSHOT.get() {
        lock.write().expect("dispatch snapshot lock poisoned").model = model;
    }
}

/// Broker-only writer. Swaps the thinking config the runner will apply.
pub(crate) fn set_thinking(thinking: Option<ThinkingConfig>) {
    if let Some(lock) = SNAPSHOT.get() {
        lock.write()
            .expect("dispatch snapshot lock poisoned")
            .thinking = thinking;
    }
}

#[cfg(test)]
pub(crate) fn install_for_test(snapshot: DispatchSnapshot) {
    // Tests: OnceLock can't be cleared; if something already installed, just
    // overwrite the inner value so each test starts from a predictable state.
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
