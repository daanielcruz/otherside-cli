//! `SessionId` newtype — UUID v4 rendered as lowercase hex with
//! hyphens.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionId(uuid::Uuid);

impl SessionId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    pub fn from_hex(s: &str) -> Option<Self> {
        uuid::Uuid::parse_str(s).ok().map(Self)
    }

    /// Fallback for directory-name parsing when the on-disk folder
    /// doesn't look like a canonical UUID. Exposes the raw string
    /// without validation — callers that care should use
    /// [`from_hex`] instead.
    pub fn from_hex_unchecked(s: &str) -> Self {
        match uuid::Uuid::parse_str(s) {
            Ok(u) => Self(u),
            Err(_) => Self(uuid::Uuid::nil()),
        }
    }

    pub fn as_str(&self) -> String {
        self.0.to_string()
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_produces_valid_uuid() {
        let id = SessionId::new();
        assert_ne!(id.to_string(), SessionId(uuid::Uuid::nil()).to_string());
    }

    #[test]
    fn round_trip_via_hex() {
        let id = SessionId::new();
        let s = id.to_string();
        let parsed = SessionId::from_hex(&s).unwrap();
        assert_eq!(id, parsed);
    }

    #[test]
    fn from_hex_rejects_invalid() {
        assert!(SessionId::from_hex("not a uuid").is_none());
    }
}
