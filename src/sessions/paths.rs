use std::path::{Path, PathBuf};

use super::SessionId;

/// Max bytes we'll keep for a sanitized path component before truncating and
/// appending a hash suffix. Matches upstream `MAX_SANITIZED_LENGTH` from
/// `utils/sessionStoragePortable.ts:293` — most filesystems cap individual
/// components at 255 bytes; the 55-byte headroom leaves room for the suffix.
pub const MAX_SANITIZED_LENGTH: usize = 200;

/// Sanitize an arbitrary path (typically a cwd) into a single filesystem-safe
/// component. Mirrors upstream `sanitizePath` (`utils/sessionStoragePortable.ts:311`):
/// replace every non-alphanumeric byte with `-`, then — if the result would
/// exceed `MAX_SANITIZED_LENGTH` — truncate and append `-<djb2-base36-abs>`
/// so nested paths stay collision-resistant without busting the 255-byte limit.
///
/// Example: `/Users/foo/my-project` → `-Users-foo-my-project`.
pub fn sanitize_path(input: &str) -> String {
    let mut sanitized = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            sanitized.push(ch);
        } else {
            sanitized.push('-');
        }
    }
    if sanitized.len() <= MAX_SANITIZED_LENGTH {
        return sanitized;
    }
    let hash = djb2_abs_base36(input);
    let mut out = String::with_capacity(MAX_SANITIZED_LENGTH + 1 + hash.len());
    out.push_str(&sanitized[..MAX_SANITIZED_LENGTH]);
    out.push('-');
    out.push_str(&hash);
    out
}

/// djb2 on the *original* input (pre-sanitization) — matches upstream's
/// Node-path `simpleHash` fallback in `utils/sessionStoragePortable.ts:295`.
/// Hashing the original avoids truncation-driven collisions: two distinct
/// inputs that sanitize to the same first-200 bytes still hash differently
/// because the hash eats the full pre-sanitize string.
fn djb2_abs_base36(input: &str) -> String {
    let mut hash: i32 = 0;
    for byte in input.chars() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(byte as i32);
    }
    let abs: u32 = hash.unsigned_abs();
    to_base36(abs)
}

fn to_base36(mut n: u32) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut buf = [0u8; 7];
    let mut i = buf.len();
    while n > 0 {
        let digit = (n % 36) as u8;
        i -= 1;
        buf[i] = if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        };
        n /= 36;
    }
    std::str::from_utf8(&buf[i..]).unwrap().to_string()
}

/// `<config_dir>/projects` — parent of every per-cwd session directory.
/// Matches upstream `getProjectsDir` (`utils/sessionStoragePortable.ts:325`).
pub fn projects_root(config_dir: &Path) -> PathBuf {
    config_dir.join("projects")
}

/// `<config_dir>/projects/<sanitized-cwd>` — per-cwd session directory.
/// Matches upstream `getProjectDir` (`utils/sessionStoragePortable.ts:329`).
pub fn project_dir(config_dir: &Path, cwd: &Path) -> PathBuf {
    projects_root(config_dir).join(sanitize_path(&cwd.to_string_lossy()))
}

/// `<config_dir>/projects/<sanitized-cwd>/<session-id>.jsonl` — the actual
/// transcript file. Upstream writes one JSONL per session UUID under the
/// cwd-derived subdir; otherside now matches.
pub fn transcript_path(config_dir: &Path, cwd: &Path, id: &SessionId) -> PathBuf {
    project_dir(config_dir, cwd).join(format!("{}.jsonl", id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_slashes_with_hyphens() {
        assert_eq!(sanitize_path("/Users/foo/bar"), "-Users-foo-bar");
    }

    #[test]
    fn sanitize_replaces_every_non_alphanumeric() {
        assert_eq!(
            sanitize_path("/tmp/my.repo_v2-final"),
            "-tmp-my-repo-v2-final"
        );
    }

    #[test]
    fn sanitize_under_limit_has_no_hash_suffix() {
        let out = sanitize_path("/short/path");
        assert!(out.len() <= MAX_SANITIZED_LENGTH);
        assert_eq!(out, "-short-path");
    }

    #[test]
    fn sanitize_above_limit_appends_djb2_hash() {
        let deep = "/".to_string() + &"a".repeat(MAX_SANITIZED_LENGTH + 50);
        let out = sanitize_path(&deep);
        assert!(out.len() > MAX_SANITIZED_LENGTH);
        assert!(out[..MAX_SANITIZED_LENGTH].len() == MAX_SANITIZED_LENGTH);
        let suffix = &out[MAX_SANITIZED_LENGTH..];
        assert!(suffix.starts_with('-'));
        // base36: 0-9a-z
        assert!(suffix[1..].chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn sanitize_distinguishes_long_paths_beyond_the_cut() {
        // Both inputs share the first MAX_SANITIZED_LENGTH sanitized chars but
        // diverge beyond — djb2 over the full pre-sanitize string must still
        // produce distinct suffixes so they don't collide on disk.
        let common = "/".to_string() + &"a".repeat(MAX_SANITIZED_LENGTH + 10);
        let a = format!("{common}/branch-one");
        let b = format!("{common}/branch-two");
        assert_ne!(sanitize_path(&a), sanitize_path(&b));
    }

    #[test]
    fn projects_root_nests_under_config_dir() {
        assert_eq!(
            projects_root(Path::new("/tmp/cfg")),
            Path::new("/tmp/cfg/projects")
        );
    }

    #[test]
    fn project_dir_embeds_sanitized_cwd() {
        let cfg = Path::new("/tmp/cfg");
        let cwd = Path::new("/Users/foo/bar");
        let dir = project_dir(cfg, cwd);
        assert_eq!(dir, Path::new("/tmp/cfg/projects/-Users-foo-bar"));
    }

    #[test]
    fn transcript_path_uses_uuid_jsonl_under_project_dir() {
        let cfg = Path::new("/tmp/cfg");
        let cwd = Path::new("/Users/foo/bar");
        let id = SessionId::new();
        let path = transcript_path(cfg, cwd, &id);
        let parent = path.parent().unwrap();
        assert_eq!(parent, Path::new("/tmp/cfg/projects/-Users-foo-bar"));
        assert_eq!(
            path.file_name().and_then(|s| s.to_str()).unwrap(),
            &format!("{id}.jsonl"),
        );
    }

    #[test]
    fn djb2_matches_upstream_reference_vectors() {
        // Hand-computed against the upstream formula
        // `h = ((h<<5)-h+c.charCodeAt(0))|0` then `Math.abs(h).toString(36)`.
        // 'a' (97)           →  97.toString(36) = "2p"
        // 'ab' (97,98)       → 3105.toString(36) = "2e9"
        // 'hello' (full)     → 99162322.toString(36) = "1n1e4y"
        assert_eq!(djb2_abs_base36("a"), "2p");
        assert_eq!(djb2_abs_base36("ab"), "2e9");
        assert_eq!(djb2_abs_base36("hello"), "1n1e4y");
    }

    #[test]
    fn djb2_handles_empty_input() {
        assert_eq!(djb2_abs_base36(""), "0");
    }
}
