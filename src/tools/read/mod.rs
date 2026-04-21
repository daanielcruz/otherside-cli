

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::{json, Value};

pub mod set;

use crate::tools::ToolError;
use set as read_set;

const DEFAULT_LIMIT: usize = 2000;
const MAX_LINE_CHARS: usize = 2000;

const MAX_FILE_SIZE: u64 = 256 * 1024;

const BLOCKED_DEVICE_PATHS: &[&str] = &[
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
    "/dev/console",
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/full",
    "/proc/self/fd/0",
    "/proc/self/fd/1",
    "/proc/self/fd/2",
];

const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "a", "lib", "o",
    "bin", "dat", "class", "jar", "war",
    "pyc", "pyo", "pyd",
    "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "zst",
    "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "ogg", "webm",
    "wasm",
];

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

    let canonical = path.to_string_lossy();
    if BLOCKED_DEVICE_PATHS.iter().any(|d| canonical == *d) {
        return Err(ToolError::InvalidArgs(format!(
            "blocked device path: {canonical}"
        )));
    }

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

        if BLOCKED_EXTENSIONS.iter().any(|b| *b == ext) {
            return Err(ToolError::InvalidArgs(format!(
                "binary extension .{ext} cannot be read as text"
            )));
        }
    }

    if !path.exists() {
        return Err(ToolError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("File does not exist: {}", path.display()),
        )));
    }

    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_FILE_SIZE {
            return Err(ToolError::InvalidArgs(format!(
                "file too large: {} bytes (max {})",
                meta.len(),
                MAX_FILE_SIZE
            )));
        }
    }

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

    #[test]
    fn read_rejects_blocked_device_path() {

        let err = read(&json!({ "file_path": "/dev/zero" })).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn read_rejects_binary_extension() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-fake-{}.exe",
            std::process::id()
        ));
        fs::write(&tmp, b"MZ\0\0").unwrap();
        let err = read(&json!({ "file_path": tmp.to_str().unwrap() })).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn read_rejects_oversized_file() {
        let tmp = std::env::temp_dir().join(format!(
            "otherside-fake-big-{}.txt",
            std::process::id()
        ));

        let blob = vec![b'a'; (MAX_FILE_SIZE as usize) + 1];
        fs::write(&tmp, &blob).unwrap();
        let err = read(&json!({ "file_path": tmp.to_str().unwrap() })).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
        fs::remove_file(&tmp).ok();
    }
}
