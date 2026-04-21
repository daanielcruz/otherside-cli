

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub const VERIFIER_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkcePair {

    pub verifier: String,

    pub challenge: String,
}

impl PkcePair {

    pub fn generate() -> Self {
        let mut bytes = [0u8; VERIFIER_BYTES];
        rand::rng().fill_bytes(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = s256_challenge(&verifier);
        Self { verifier, challenge }
    }

    #[cfg(test)]
    pub fn from_verifier(verifier: impl Into<String>) -> Self {
        let verifier = verifier.into();
        let challenge = s256_challenge(&verifier);
        Self { verifier, challenge }
    }
}

pub fn s256_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_verifier_length() {

        let pair = PkcePair::generate();
        assert_eq!(pair.verifier.len(), 43);
    }

    #[test]
    fn challenge_is_sha256_b64url() {

        let c = s256_challenge("hello");
        assert_eq!(c, "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
    }

    #[test]
    fn verifier_alphabet_is_base64url_nopad() {

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
