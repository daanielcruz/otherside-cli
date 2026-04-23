
use std::fmt;

use rand::distr::{Alphanumeric, SampleString};
use rand::rng;
use rand::RngCore;

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

pub fn create_agent_id(label: Option<&str>) -> String {
    let mut bytes = [0u8; 8];
    rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    match label {
        Some(l) if !l.is_empty() => format!("a{l}-{hex}"),
        _ => format!("a{hex}"),
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

    #[test]
    fn create_agent_id_matches_upstream_no_label_shape() {
        
        for _ in 0..64 {
            let id = create_agent_id(None);
            assert_eq!(id.len(), 17, "unexpected len: {id} ({})", id.len());
            let mut chars = id.chars();
            assert_eq!(chars.next(), Some('a'), "missing `a` prefix: {id}");
            for c in chars {
                assert!(c.is_ascii_hexdigit(), "non-hex char in suffix: {id}");
                assert!(!c.is_ascii_uppercase(), "uppercase hex breaks parity: {id}");
            }
        }
    }

    #[test]
    fn create_agent_id_matches_upstream_labeled_shape() {
        
        let id = create_agent_id(Some("compact"));
        assert!(id.starts_with("acompact-"), "bad prefix: {id}");
        let suffix = &id["acompact-".len()..];
        assert_eq!(suffix.len(), 16, "suffix should be 16 hex chars: {suffix}");
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn create_agent_id_empty_label_falls_back_to_no_label() {
        let id = create_agent_id(Some(""));
        assert_eq!(id.len(), 17);
        assert!(id.starts_with('a'));
        
        assert!(!id.contains('-'), "empty label must not leave a dangling dash: {id}");
    }

    #[test]
    fn create_agent_id_does_not_repeat() {
        let a = create_agent_id(None);
        let b = create_agent_id(None);
        assert_ne!(a, b);
    }
}
