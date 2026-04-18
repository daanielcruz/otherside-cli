//! Grep tool — spawns `rg` (ripgrep) and returns matching paths or
//! content. Falls back to an error if ripgrep isn't on PATH.

use std::path::PathBuf;
use std::process::Command;

use serde_json::{json, Value};

use super::ToolError;

const DEFAULT_HEAD_LIMIT: usize = 250;

pub fn grep(args: &Value) -> Result<Value, ToolError> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("pattern is required".into()))?;

    let search_path = args
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let output_mode = args
        .get("output_mode")
        .and_then(Value::as_str)
        .unwrap_or("files_with_matches");

    let head_limit = args
        .get("head_limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_HEAD_LIMIT);

    let mut cmd = Command::new("rg");
    cmd.arg(pattern).arg(&search_path);

    match output_mode {
        "files_with_matches" => {
            cmd.arg("-l");
        }
        "count" => {
            cmd.arg("-c");
        }
        "content" => {
            if args.get("-n").and_then(Value::as_bool).unwrap_or(true) {
                cmd.arg("-n");
            }
        }
        _ => {
            return Err(ToolError::InvalidArgs(format!(
                "unknown output_mode: {output_mode}"
            )));
        }
    }

    if args.get("-i").and_then(Value::as_bool).unwrap_or(false) {
        cmd.arg("-i");
    }
    if let Some(g) = args.get("glob").and_then(Value::as_str) {
        cmd.arg("--glob").arg(g);
    }
    if let Some(t) = args.get("type").and_then(Value::as_str) {
        cmd.arg("--type").arg(t);
    }
    if args.get("multiline").and_then(Value::as_bool).unwrap_or(false) {
        cmd.arg("-U").arg("--multiline-dotall");
    }
    if let Some(a) = args.get("-A").and_then(Value::as_u64) {
        cmd.arg("-A").arg(a.to_string());
    }
    if let Some(b) = args.get("-B").and_then(Value::as_u64) {
        cmd.arg("-B").arg(b.to_string());
    }
    if let Some(c) = args
        .get("-C")
        .or_else(|| args.get("context"))
        .and_then(Value::as_u64)
    {
        cmd.arg("-C").arg(c.to_string());
    }

    let out = cmd
        .output()
        .map_err(|_| ToolError::Unsupported("rg (ripgrep) not found on PATH".into()))?;

    let stdout =
        String::from_utf8(out.stdout).map_err(|_| ToolError::Unsupported("rg output not utf-8".into()))?;
    let lines: Vec<&str> = stdout.lines().collect();
    let total = lines.len();
    let limited: Vec<&str> = if head_limit == 0 {
        lines.clone()
    } else {
        lines.iter().take(head_limit).copied().collect()
    };

    Ok(json!({
        "mode": output_mode,
        "matches": limited,
        "truncated": total > limited.len(),
        "exit": out.status.code().unwrap_or(-1),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn grep_missing_pattern_errors() {
        let err = grep(&json!({})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn grep_finds_match_in_files_mode() {
        if Command::new("rg").arg("--version").output().is_err() {
            return;
        }
        let tmp = std::env::temp_dir().join(format!(
            "otherside-grep-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("one.txt"), "hello world").unwrap();
        fs::write(tmp.join("two.txt"), "nothing here").unwrap();

        let res = grep(&json!({
            "pattern": "hello",
            "path": tmp.to_str().unwrap(),
        }))
        .unwrap();
        let matches = res["matches"].as_array().unwrap();
        let any_match = matches.iter().any(|v| {
            v.as_str().is_some_and(|s| s.ends_with("one.txt"))
        });
        assert!(any_match, "expected one.txt in matches: {matches:?}");

        fs::remove_dir_all(&tmp).ok();
    }
}
