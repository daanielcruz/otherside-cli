//! Unified session state module.
//!
//! # SSOT rule (Single Source of Truth)
//!
//! The `/model` ✔ drift bug that shipped in 2026-04-20 had a simple
//! cause: two places encoded "which model is active" — `st.model` and
//! a hardcoded `i == 0` in `draw_model_overlay`. The symptom fix
//! (commit 6e94d69) added `active_action_id` on the overlay; this
//! module is the structural fix so equivalent drifts can't start.
//!
//! ## Four rules, enforced by module boundaries
//!
//! 1. **Um fato = um dono.** Any field representing an identity
//!    consumed by UI render, wire request, or persistence
//!    (`model`, `provider_id`, `effort_label`, `permission_mode`,
//!    `context_window`) lives on [`SessionState`] ONLY. Render paths,
//!    overlay constructors, statusline **look up** via `state.session.*`
//!    or `state.session.is_active_*()` — they never copy to a snapshot
//!    local.
//!
//! 2. **Overlays são view-only.** Overlay constructors take
//!    `&SessionState`, read the relevant field at mount time, and
//!    store its `action_id` string on the overlay for the ✔ check.
//!    Cursor moves freely with arrow keys; the active indicator only
//!    changes when the event loop calls an `AppState::commit_*`
//!    method. Overlay rebuilds (e.g. ←→ effort on /model picker)
//!    re-read `&session`, NEVER use the cursor's row as the anchor.
//!
//! 3. **Permission mode is session-scoped, NEVER persisted.**
//!    Directive 2026-04-20. `AppState::commit_permission_change`
//!    mutates `session.permission_mode` and does NOT call
//!    `persistence.commit_session_defaults`. Every other Session
//!    field (model, effort, provider) persists atomically.
//!
//! 4. **Cross-bucket mutations go through AppState.** Any operation
//!    touching two or more buckets (e.g. `submit()` touches
//!    conversation + reads session + mutates UI) lives on
//!    [`AppState`]. Per-bucket structs expose mutators for their
//!    own bucket only. Event loop receives `&mut AppState` and
//!    calls `app.submit()`, never `app.session.*` + `app.conversation.*`
//!    in sequence on one keypress (atomicity of invariants).
//!
//! # Migration status
//!
//! Fase 1 (current): [`SessionState`] carves out {model, effort_label,
//! permission_mode, context_window} from the legacy `ConversationState`
//! in `src/tui/state.rs`. ConversationState now carries
//! `pub session: SessionState`; callers migrate from `st.model` to
//! `st.session.model` mechanically.
//!
//! Fase 2 (planned): fold `PersistenceState` over {Settings, State,
//! CachedCreds}.
//!
//! Fase 3 (planned): `AppState { session, conversation, persistence }`
//! aggregate; cross-bucket mutators (`submit`, `finish_stream`,
//! `fail_stream`, `commit_*`) move there.

pub mod session;

pub use session::SessionState;
