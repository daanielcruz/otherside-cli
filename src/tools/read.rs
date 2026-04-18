//! Read tool — file contents with cat -n formatting. Mirrors the
//! upstream tool behavior: absolute path, default 2000-line limit,
//! optional offset + limit, images / PDFs / notebooks stubbed to a
//! descriptive error for MVP.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::{json, Value};

use super::read_set;
use super::ToolError;

const DEFAULT_LIMIT: usize = 2000;
const MAX_LINE_CHARS: usize = 2000;

pub fn read(args: &Value) -> Result<Value, ToolError> {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("file_path is required".into()))?;

    let path = Path::new(file_path);
    if !path.is_absolute() {
        return Err(ToolError::InvalidArgs(
            "file_path must be absolute".into(),
        ));
    }

    // MVP: punt on images / PDFs / notebooks with an informative error.
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        let ext = ext.to_ascii_lowercase();
        if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
            return Err(ToolError::Unsupported(
                "image read not yet wired in this build".into(),
            ));
        }
        if ext == "pdf" {
            return Err(ToolError::Unsupported(
                "pdf read not yet wired in this build".into(),
            ));
        }
        if ext == "ipynb" {
            return Err(ToolError::Unsupported(
                "notebook read not yet wired in this build".into(),
            ));
        }
    }

    if !path.exists() {
        return Err(ToolError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("File does not exist: {}", path.display()),
        )));
    }

    // Record the read so the Edit tool's Read-before-Edit gate is
    // satisfied for this session.
    read_set::global().insert(path);

    let offset = args
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_LIMIT);

    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);

    let mut output = String::new();
    let mut total_lines: usize = 0;
    let mut emitted: usize = 0;
    let start_line = offset.saturating_add(1);

    for (idx, line_res) in reader.lines().enumerate() {
        total_lines = idx + 1;
        if idx < offset {
            continue;
        }
        if emitted >= limit {
            break;
        }
        let line = line_res?;
        let truncated: String = if line.chars().count() > MAX_LINE_CHARS {
            line.chars().take(MAX_LINE_CHARS).collect::<String>() + " …"
        } else {
            line
        };
        output.push_str(&format!("{:>6}\t{}\n", idx + 1, truncated));
        emitted += 1;
    }

    // Consume the rest of the iterator to count total lines when we stopped early.
    if emitted == limit {
        let file_again = fs::File::open(path)?;
        let reader_again = BufReader::new(file_again);
        total_lines = reader_again.lines().count();
    }

    if emitted == 0 {
        return Ok(json!({
            "content": "[empty file]",
            "numLines": 0,
            "startLine": start_line,
            "totalLines": total_lines,
        }));
    }

    Ok(json!({
        "content": output,
        "numLines": emitted,
        "startLine": start_line,
        "totalLines": total_lines,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn read_small_file_returns_numbered_lines() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-tool-read-{}.txt",
            std::process::id()
        ));
        let mut f = fs::File::create(&tmp).unwrap();
        writeln!(f, "alpha").unwrap();
        writeln!(f, "beta").unwrap();
        writeln!(f, "gamma").unwrap();

        let res = read(&json!({ "file_path": tmp.to_str().unwrap() })).unwrap();
        let content = res["content"].as_str().unwrap();
        assert!(content.contains("     1\talpha"));
        assert!(content.contains("     2\tbeta"));
        assert!(content.contains("     3\tgamma"));
        assert_eq!(res["numLines"], 3);
        assert_eq!(res["totalLines"], 3);

        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn read_rejects_relative_path() {
        let err = read(&json!({ "file_path": "relative/path.txt" })).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn read_rejects_missing_file() {
        let err = read(&json!({ "file_path": "/definitely/not/a/real/path.txt" })).unwrap_err();
        assert!(matches!(err, ToolError::Io(_)));
    }

    #[test]
    fn read_with_offset_and_limit() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-tool-read-win-{}.txt",
            std::process::id()
        ));
        let mut f = fs::File::create(&tmp).unwrap();
        for i in 1..=10 {
            writeln!(f, "line {i}").unwrap();
        }

        let res = read(&json!({
            "file_path": tmp.to_str().unwrap(),
            "offset": 3,
            "limit": 2,
        }))
        .unwrap();
        let content = res["content"].as_str().unwrap();
        assert!(content.contains("     4\tline 4"));
        assert!(content.contains("     5\tline 5"));
        assert!(!content.contains("line 3"));
        assert!(!content.contains("line 6"));
        assert_eq!(res["numLines"], 2);
        assert_eq!(res["startLine"], 4);
        assert_eq!(res["totalLines"], 10);

        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn read_image_ext_stubbed() {
        let tmp = std::env::temp_dir().join("otherside-fake.png");
        fs::write(&tmp, b"fake").unwrap();
        let err = read(&json!({ "file_path": tmp.to_str().unwrap() })).unwrap_err();
        assert!(matches!(err, ToolError::Unsupported(_)));
        fs::remove_file(&tmp).ok();
    }
}
