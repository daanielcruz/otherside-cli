//! Glob tool — fast file-pattern matching, sorted by mtime descending.

use std::path::PathBuf;
use std::time::SystemTime;

use serde_json::{json, Value};

use super::ToolError;

const MAX_RESULTS: usize = 100;

pub fn glob(args: &Value) -> Result<Value, ToolError> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("pattern is required".into()))?;

    let search_root = args
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let started = std::time::Instant::now();

    // Compose the full glob expression: `<root>/<pattern>`.
    let joined = search_root.join(pattern);
    let full_pattern = joined
        .to_str()
        .ok_or_else(|| ToolError::InvalidArgs("path+pattern not utf-8".into()))?;

    let paths: Vec<PathBuf> = match ::glob::glob(full_pattern) {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(e) => return Err(ToolError::GlobPattern(e.to_string())),
    };

    let mut entries: Vec<(PathBuf, SystemTime)> = paths
        .into_iter()
        .filter_map(|p| {
            let meta = p.metadata().ok()?;
            let mtime = meta.modified().ok()?;
            Some((p, mtime))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    let truncated = entries.len() > MAX_RESULTS;
    let filenames: Vec<String> = entries
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(p, _)| p.to_string_lossy().into_owned())
        .collect();

    Ok(json!({
        "durationMs": started.elapsed().as_millis() as u64,
        "numFiles": filenames.len(),
        "filenames": filenames,
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn glob_matches_star_pattern() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-glob-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("alpha.rs"), "").unwrap();
        fs::write(tmp.join("beta.rs"), "").unwrap();
        fs::write(tmp.join("gamma.txt"), "").unwrap();

        let res = glob(&json!({
            "pattern": "*.rs",
            "path": tmp.to_str().unwrap(),
        }))
        .unwrap();
        let filenames = res["filenames"].as_array().unwrap();
        assert_eq!(filenames.len(), 2);
        let names: Vec<&str> = filenames.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.iter().any(|n| n.ends_with("alpha.rs")));
        assert!(names.iter().any(|n| n.ends_with("beta.rs")));
        assert!(!names.iter().any(|n| n.ends_with("gamma.txt")));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn glob_missing_pattern_errors() {
        let err = glob(&json!({})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }
}
