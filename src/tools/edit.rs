//! Edit tool — exact-string replacement inside a previously-Read file.
//!
//! The Read-before-Edit gate is non-negotiable (upstream invariant):
//! the caller must have Read'd the file earlier in the same session.
//! We enforce via the process-wide [`read_set::global()`]; an
//! in-process session owns one instance.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{read_set, ToolError};

/// Execute an Edit tool call.
///
/// Schema:
/// - `file_path: String` (required, absolute)
/// - `old_string: String` (required)
/// - `new_string: String` (required, must differ from `old_string`)
/// - `replace_all: bool` (optional, default false)
pub fn edit(args: &Value) -> Result<Value, ToolError> {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("missing or non-string `file_path`".into()))?;
    let old_string = args
        .get("old_string")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("missing or non-string `old_string`".into()))?;
    let new_string = args
        .get("new_string")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("missing or non-string `new_string`".into()))?;
    let replace_all = args
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if old_string == new_string {
        return Err(ToolError::InvalidArgs(
            "`new_string` must differ from `old_string`".into(),
        ));
    }

    let path = PathBuf::from(file_path);
    if !path.is_absolute() {
        return Err(ToolError::InvalidArgs(format!(
            "`file_path` must be absolute: {file_path}"
        )));
    }
    if !read_set::global().contains(&path) {
        return Err(ToolError::InvalidArgs(format!(
            "file `{file_path}` was not read in this session; call Read first"
        )));
    }

    let contents = std::fs::read_to_string(&path)?;
    let matches = contents.matches(old_string).count();
    if matches == 0 {
        return Err(ToolError::InvalidArgs(format!(
            "`old_string` not found in {file_path}"
        )));
    }
    if matches > 1 && !replace_all {
        return Err(ToolError::InvalidArgs(format!(
            "`old_string` appears {matches} times — pass `replace_all: true` or supply more context"
        )));
    }

    let updated = if replace_all {
        contents.replace(old_string, new_string)
    } else {
        contents.replacen(old_string, new_string, 1)
    };

    write_preserving_mode(&path, updated.as_bytes())?;

    Ok(json!({
        "status": "ok",
        "file_path": file_path,
        "replaced": if replace_all { matches } else { 1 },
    }))
}

fn write_preserving_mode(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)
            .map(|m| m.permissions().mode())
            .unwrap_or(0o644);
        std::fs::write(path, bytes)?;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(mode);
        std::fs::set_permissions(path, perms)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(contents: &str) -> PathBuf {
        use uuid::Uuid;
        let path = std::env::temp_dir().join(format!("otherside_edit_{}", Uuid::new_v4().simple()));
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn edit_without_read_fails() {
        read_set::global().clear();
        let file = temp_file("hello world");
        let args = json!({
            "file_path": file.to_string_lossy(),
            "old_string": "hello",
            "new_string": "howdy",
        });
        let err = edit(&args).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn edit_after_read_replaces() {
        let file = temp_file("hello world");
        read_set::global().insert(&file);
        let args = json!({
            "file_path": file.to_string_lossy(),
            "old_string": "hello",
            "new_string": "howdy",
        });
        edit(&args).unwrap();
        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after, "howdy world");
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn ambiguous_without_replace_all_errors() {
        let file = temp_file("foo foo foo");
        read_set::global().insert(&file);
        let args = json!({
            "file_path": file.to_string_lossy(),
            "old_string": "foo",
            "new_string": "bar",
        });
        let err = edit(&args).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn replace_all_handles_multiple_matches() {
        let file = temp_file("foo foo foo");
        read_set::global().insert(&file);
        let args = json!({
            "file_path": file.to_string_lossy(),
            "old_string": "foo",
            "new_string": "bar",
            "replace_all": true,
        });
        edit(&args).unwrap();
        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after, "bar bar bar");
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn missing_old_string_errors() {
        let file = temp_file("just some content");
        read_set::global().insert(&file);
        let args = json!({
            "file_path": file.to_string_lossy(),
            "old_string": "not here",
            "new_string": "whatever",
        });
        let err = edit(&args).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn relative_path_rejected() {
        let args = json!({
            "file_path": "relative/path.txt",
            "old_string": "x",
            "new_string": "y",
        });
        let err = edit(&args).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }
}
