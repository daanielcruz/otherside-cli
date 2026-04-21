

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::tools::ToolError;

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

    let num_lines = if content.is_empty() {
        0
    } else {
        content.lines().count() as u64
    };

    Ok(json!({
        "status": "ok",
        "file_path": file_path,
        "created": !existed,
        "bytes_written": content.len(),
        "numLines": num_lines,
    }))
}

fn write_with_mode(path: &Path, bytes: &[u8], existed: bool) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "file_path has no basename"))?;
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stage_name = format!(
        "{}.otherside.{pid}.{nanos}.tmp",
        file_name.to_string_lossy()
    );
    let stage_path = parent.join(&stage_name);

    let _ = std::fs::remove_file(&stage_path);

    let _prior_mode: Option<u32> = {
        #[cfg(unix)]
        {
            if existed {
                std::fs::metadata(path).ok().map(|m| m.permissions().mode())
            } else {
                None
            }
        }
        #[cfg(not(unix))]
        {
            let _ = existed;
            None
        }
    };

    let cleanup = || {
        let _ = std::fs::remove_file(&stage_path);
    };
    let staged = match (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&stage_path)?;
        f.write_all(bytes)?;
        f.flush()?;
        f.sync_all()?;
        drop(f);

        #[cfg(unix)]
        {
            let mode = _prior_mode.unwrap_or(0o644);
            let mut perms = std::fs::metadata(&stage_path)?.permissions();
            perms.set_mode(mode);
            std::fs::set_permissions(&stage_path, perms)?;
        }

        std::fs::rename(&stage_path, path)?;
        Ok(())
    })() {
        Ok(()) => Ok(()),
        Err(e) => {
            cleanup();
            Err(e)
        }
    };
    staged
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

    #[test]
    fn atomic_write_leaves_no_stage_file() {

        let path = unique_path();
        let args = json!({
            "file_path": path.to_string_lossy(),
            "content": "atomic",
        });
        write(&args).unwrap();
        let parent = path.parent().unwrap();
        let base = path.file_name().unwrap().to_string_lossy().to_string();
        let leftover = std::fs::read_dir(parent).unwrap().any(|e| {
            e.ok()
                .map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    name.starts_with(&format!("{base}.otherside.")) && name.ends_with(".tmp")
                })
                .unwrap_or(false)
        });
        assert!(!leftover, "atomic write left a stage file behind");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn atomic_write_preserves_original_on_stage_failure() {

        let path = unique_path();
        std::fs::write(&path, b"original").unwrap();

        let args = json!({
            "file_path": path.to_string_lossy(),
            "content": "new",
        });
        write(&args).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        std::fs::remove_file(&path).ok();
    }
}
