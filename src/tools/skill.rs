//! `Skill` tool — loads bundled skill content from disk.
//!
//! Captured upstream schema accepts `{ skill: String, args?: String }`
//! and returns the skill's body text. Skills live under
//! `otherside-cli/skills/<name>/SKILL.md` — a deterministic, no-network
//! lookup so the model can compose behavior from first-party content.
//!
//! 010 ships one placeholder skill (`hello`) to exercise the dispatch
//! path. Broader skills catalog land in a follow-up.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::ToolError;

/// Resolve `otherside-cli/skills/<name>/SKILL.md` relative to the
/// crate root. Cargo tests and the `otherside` binary both run with
/// CWD at the crate root so relative lookup suffices.
fn skill_path(name: &str) -> PathBuf {
    PathBuf::from("skills").join(name).join("SKILL.md")
}

/// Enumerate the bundled skills under `./skills/`. Used to compose a
/// helpful error when the model asks for an unknown skill name.
/// Returns an empty vec when the directory is missing (CWD not at the
/// crate root) — unknown is unknown either way.
fn list_bundled_skills() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let root = PathBuf::from("skills");
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if entry.path().join("SKILL.md").exists() {
                    if let Some(name) = entry.file_name().to_str() {
                        out.push(name.to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out
}

pub fn skill(args: &Value) -> Result<Value, ToolError> {
    let name = args
        .get("skill")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("skill name is required".into()))?;
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return Err(ToolError::InvalidArgs(format!(
            "invalid skill name: {name}"
        )));
    }
    let path = skill_path(name);
    let content = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // Enumerate bundled skills so the model (or the user
            // reading the transcript) knows the actual surface. Upstream
            // ships ~9 skills; otherside bundles a subset, so an
            // unrecognized name most commonly means "not ported yet".
            let available = list_bundled_skills();
            let hint = if available.is_empty() {
                "no skills bundled in this build".to_string()
            } else {
                format!("available: {}", available.join(", "))
            };
            ToolError::InvalidArgs(format!(
                "unknown skill: {name} ({hint})"
            ))
        } else {
            ToolError::Io(e)
        }
    })?;
    let forwarded_args = args
        .get("args")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(json!({
        "skill": name,
        "args": forwarded_args,
        "content": content,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_missing_name_errors() {
        let err = skill(&json!({})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn skill_unknown_errors_cleanly() {
        let err = skill(&json!({"skill": "definitely-not-a-real-skill-xyz"})).unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("unknown skill"));
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn skill_rejects_path_traversal() {
        assert!(skill(&json!({"skill": "../etc/passwd"})).is_err());
        assert!(skill(&json!({"skill": "foo/bar"})).is_err());
    }

    #[test]
    fn skill_empty_name_errors() {
        assert!(skill(&json!({"skill": ""})).is_err());
    }
}
