

use std::fmt;

use rand::distr::{Alphanumeric, SampleString};
use rand::rng;

pub const TASK_ID_LEN: usize = 9;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TaskId(String);

impl TaskId {

    pub fn generate() -> Self {
        let raw = Alphanumeric.sample_string(&mut rng(), TASK_ID_LEN);
        Self(raw.to_lowercase())
    }

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
