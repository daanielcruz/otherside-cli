//! Background task store for the TUI agent background UX.
//!
//! Home for every mutation of "a task exists, is it running, is it
//! backgrounded, what did it produce" — consumed by:
//!
//! - Footer pill render (`src/tui/render.rs`) via
//!   [`pill_label::get_pill_label`] — byte-match strings with upstream.
//! - `/tasks` + `/bashes` panel + `BackgroundTasksDialog` widget.
//! - Ctrl+B hotkey handler (source: `LocalShellTask.tsx:400-429`
//!   `backgroundAll`).
//! - `<task-notification>` XML injection on next user turn
//!   (compat zone — `src/harness/task_notification.rs`).
//! - Deferred `Task*` tool family (TaskCreate/List/Get/Update/
//!   Output/Stop) — training anchors, names verbatim per R-20.
//!
//! # Threading model
//!
//! Store is `Arc<RwLock<HashMap<TaskId, TaskRecord>>>`. Spawner side
//! (runner on `tokio::spawn`) updates state on completion; TUI side
//! (event loop) reads state for render + pill + dialog. All blocking
//! I/O inside the runner wraps under `tokio::task::block_in_place`
//! per R-107.
//!
//! # Scope (wave-1, openspec 015)
//!
//! - Shell + Agent task kinds. `Generic` left as a catch-all for
//!   future tool families.
//! - No persistence across sessions — store is in-memory.
//! - No teammate/cloud tasks — those live on a different upstream
//!   code path and are out of scope per user directive.

pub mod id;
pub mod pill_label;
pub mod state;
pub mod store;

pub use id::TaskId;
pub use state::{TaskKind, TaskRecord, TaskState};
pub use store::TaskStore;
