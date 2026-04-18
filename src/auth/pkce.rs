//! PKCE (RFC 7636) code verifier + S256 challenge.
//!
//! Shared across providers — every upstream OAuth flow we piggyback on (Anthropic,
//! OpenAI/Codex, Google/Gemini) layers PKCE on top of the authorization-code flow.
//! The verifier is a high-entropy random string; the challenge is
//! `base64url(sha256(verifier))`.
//!
//! # Verifier length
//!
//! Captured from the upstream Anthropic CLI 2.1.113: the verifier we observed
//! was 43 chars = 32 bytes base64url-no-padding. RFC 7636 §4.1 mandates
//! 43..128 chars from the allowed alphabet. We default to 32 bytes (→ 43 chars
//! encoded) to match observed behavior exactly.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Size of the raw random verifier in bytes. 32 bytes encodes to 43 chars
/// base64url-no-padding, matching the upstream captured verifier length.
pub const VERIFIER_BYTES: usize = 32;

/// A PKCE verifier + its S256 challenge pair.
///
/// Hold both values locally between the authorize request (where the
/// challenge is sent) and the token exchange (where the verifier is sent).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkcePair {
    /// Random verifier — sent in token exchange body as `code_verifier`.
    pub verifier: String,
    /// Derived challenge — sent in authorize URL as `code_challenge`.
    /// Always paired with `code_challenge_method=S256`.
    pub challenge: String,
}

impl PkcePair {
    /// Generate a fresh PKCE pair with a 32-byte cryptographically-random
    /// verifier.
    ///
    /// Uses `rand::rngs::OsRng` under the hood — cryptographically secure
    /// on every platform we target.
    pub fn generate() -> Self {
        let mut bytes = [0u8; VERIFIER_BYTES];
        rand::rng().fill_bytes(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = s256_challenge(&verifier);
        Self { verifier, challenge }
    }

    /// Reconstruct a pair from an existing verifier. Used only in tests.
    #[cfg(test)]
    pub fn from_verifier(verifier: impl Into<String>) -> Self {
        let verifier = verifier.into();
        let challenge = s256_challenge(&verifier);
        Self { verifier, challenge }
    }
}

/// Compute the S256 challenge for a given verifier.
///
/// `base64url-no-padding(sha256(verifier))` — matches RFC 7636 §4.2.
pub fn s256_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_verifier_length() {
        // 32 bytes → 43 chars base64url-no-padding. Matches the captured
        // upstream value (`7F8AyZr6EofRPzgW_FUHTBx3RD4cyTanmOWY6E5FuSY`,
        // which is exactly 43 chars).
        let pair = PkcePair::generate();
        assert_eq!(pair.verifier.len(), 43);
    }

    #[test]
    fn challenge_is_sha256_b64url() {
        // S256 challenge for a known verifier. Cross-checked against an
        // independent implementation (python hashlib + base64url).
        //
        //   python3 -c "import hashlib,base64; v='hello'.encode();
        //   print(base64.urlsafe_b64encode(hashlib.sha256(v).digest()).rstrip(b'=').decode())"
        //   → LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ
        let c = s256_challenge("hello");
        assert_eq!(c, "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
    }

    #[test]
    fn verifier_alphabet_is_base64url_nopad() {
        // Characters allowed: A-Z a-z 0-9 - _
        let pair = PkcePair::generate();
        for c in pair.verifier.chars() {
            assert!(
                c.is_ascii_alphanumeric() || c == '-' || c == '_',
                "verifier contains disallowed char {c:?}"
            );
        }
        for c in pair.challenge.chars() {
            assert!(
                c.is_ascii_alphanumeric() || c == '-' || c == '_',
                "challenge contains disallowed char {c:?}"
            );
        }
    }

    #[test]
    fn two_generations_differ() {
        // Entropy check: two generations should not collide.
        let a = PkcePair::generate();
        let b = PkcePair::generate();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.challenge, b.challenge);
    }

    #[test]
    fn from_verifier_is_deterministic() {
        let a = PkcePair::from_verifier("deterministic-test-verifier-1234567890");
        let b = PkcePair::from_verifier("deterministic-test-verifier-1234567890");
        assert_eq!(a, b);
    }
}
