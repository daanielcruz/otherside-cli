//! `TaskId` — opaque 9-char lowercase alphanumeric identifier.
//!
//! Byte-match with upstream: capture `02-after-ctrl-b.txt` shows
//! the string `Started in background as bqqmh45aj. I'll be notified
//! when it completes.` — 9 chars, `a-z0-9`. Source confirms via
//! `tasks/types.ts:9-35` + runtime generation callsite.
//!
//! Not a UUID, not prefixed — just a short random handle the user
//! can eyeball in the pill/dialog without cognitive load. Collision
//! odds for 9 chars over `[a-z0-9]` (36^9 ≈ 1e14) are negligible for
//! in-session use; the store rejects duplicates defensively anyway.

use std::fmt;

use rand::distr::{Alphanumeric, SampleString};
use rand::rng;

/// Canonical length of a task id. Locked — any drift breaks the
/// `Started in background as <id>.` byte-match contract with
/// upstream UX.
pub const TASK_ID_LEN: usize = 9;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TaskId(String);

impl TaskId {
    /// Fresh random id. Lowercase alphanumeric, exactly
    /// [`TASK_ID_LEN`] chars.
    pub fn generate() -> Self {
        let raw = Alphanumeric.sample_string(&mut rng(), TASK_ID_LEN);
        Self(raw.to_lowercase())
    }

    /// Construct from a known-good string (tests, tool-call inputs).
    /// Does NOT validate — the caller owns shape. Used in
    /// `Task*` tool dispatch where the model supplies an id it
    /// received in a prior `<task-notification>` envelope.
    pub fn from_string(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TaskId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_produces_nine_lowercase_alphanumeric() {
        for _ in 0..128 {
            let id = TaskId::generate();
            assert_eq!(
                id.as_str().len(),
                TASK_ID_LEN,
                "id `{}` has len {}, expected {}",
                id.as_str(),
                id.as_str().len(),
                TASK_ID_LEN
            );
            for c in id.as_str().chars() {
                assert!(
                    c.is_ascii_lowercase() || c.is_ascii_digit(),
                    "id `{}` has non [a-z0-9] char `{c}`",
                    id.as_str()
                );
            }
        }
    }

    #[test]
    fn generate_is_not_trivially_repeated() {
        let a = TaskId::generate();
        let b = TaskId::generate();
        assert_ne!(a, b, "consecutive generate() returned the same id");
    }
}
