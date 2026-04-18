//! Write tool — create or overwrite a file on the local filesystem.
//!
//! Unlike Edit, Write does NOT require a prior Read — it's a
//! create-or-replace operation. On existing files we preserve the
//! existing mode; new files land at 0644 on unix.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::ToolError;

/// Execute a Write tool call.
///
/// Schema:
/// - `file_path: String` (required, absolute)
/// - `content: String` (required)
pub fn write(args: &Value) -> Result<Value, ToolError> {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("missing or non-string `file_path`".into()))?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("missing or non-string `content`".into()))?;

    let path = PathBuf::from(file_path);
    if !path.is_absolute() {
        return Err(ToolError::InvalidArgs(format!(
            "`file_path` must be absolute: {file_path}"
        )));
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let existed = path.exists();
    write_with_mode(&path, content.as_bytes(), existed)?;

    Ok(json!({
        "status": "ok",
        "file_path": file_path,
        "created": !existed,
        "bytes_written": content.len(),
    }))
}

fn write_with_mode(path: &Path, bytes: &[u8], existed: bool) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let prior_mode = if existed {
            std::fs::metadata(path).ok().map(|m| m.permissions().mode())
        } else {
            None
        };
        std::fs::write(path, bytes)?;
        let mode = prior_mode.unwrap_or(0o644);
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(mode);
        std::fs::set_permissions(path, perms)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = existed;
        std::fs::write(path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_path() -> PathBuf {
        use uuid::Uuid;
        std::env::temp_dir().join(format!("otherside_write_{}", Uuid::new_v4().simple()))
    }

    #[test]
    fn write_new_file_creates_content() {
        let path = unique_path();
        let args = json!({
            "file_path": path.to_string_lossy(),
            "content": "hello",
        });
        let result = write(&args).unwrap();
        assert_eq!(result["created"], true);
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(after, "hello");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn write_over_existing_file_preserves_mode() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = unique_path();
            std::fs::write(&path, b"old").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            let args = json!({
                "file_path": path.to_string_lossy(),
                "content": "new content",
            });
            write(&args).unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o755);
            std::fs::remove_file(&path).ok();
        }
    }

    #[test]
    fn write_creates_missing_parent_dirs() {
        let root = unique_path();
        let nested = root.join("a/b/c/file.txt");
        let args = json!({
            "file_path": nested.to_string_lossy(),
            "content": "deep",
        });
        write(&args).unwrap();
        let after = std::fs::read_to_string(&nested).unwrap();
        assert_eq!(after, "deep");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn relative_path_rejected() {
        let args = json!({
            "file_path": "relative/write.txt",
            "content": "x",
        });
        let err = write(&args).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }
}
