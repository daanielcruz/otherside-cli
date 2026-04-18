//! Transcript JSONL reader + writer.
//!
//! The writer is append-only, fsyncs on every record, and sets file
//! mode 0600 on unix. The reader tolerates a truncated trailing
//! line (crash-during-write) by reporting those as end-of-stream.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use super::record::Record;
use crate::error::{Error, Result};

pub struct Writer {
    path: PathBuf,
    file: File,
}

impl Writer {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))?;
        }
        let mut opts = OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(path).map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
        })
    }

    pub fn append(&mut self, record: &Record) -> Result<()> {
        let line = record.to_line();
        self.file
            .write_all(line.as_bytes())
            .and_then(|_| self.file.write_all(b"\n"))
            .and_then(|_| self.file.sync_data())
            .map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub struct Reader;

impl Reader {
    pub fn read_all(path: &Path) -> Result<Vec<Record>> {
        if !path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(path).map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))?;
        let reader = BufReader::new(file);
        let mut out: Vec<Record> = Vec::new();
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Record>(trimmed) {
                Ok(r) => out.push(r),
                Err(_) => {
                    // Truncated / malformed trailing line — treat as EOF.
                    break;
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::record::now_iso;

    fn tmp_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "otherside_transcript_{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn write_then_read_round_trip() {
        let path = tmp_path();
        {
            let mut w = Writer::open(&path).unwrap();
            w.append(&Record::UserMessage {
                ts: now_iso(),
                content: "hi".into(),
            })
            .unwrap();
            w.append(&Record::AssistantMessage {
                ts: now_iso(),
                content: "hello".into(),
                thinking: None,
                usage: None,
            })
            .unwrap();
        }
        let records = Reader::read_all(&path).unwrap();
        assert_eq!(records.len(), 2);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn truncated_trailing_line_tolerated() {
        let path = tmp_path();
        {
            let mut w = Writer::open(&path).unwrap();
            w.append(&Record::UserMessage {
                ts: now_iso(),
                content: "first".into(),
            })
            .unwrap();
        }
        // Append a garbage half-line simulating crash mid-write.
        {
            let mut f = OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(b"{\"type\":\"user_message\",\"ts\":\"").unwrap();
        }
        let records = Reader::read_all(&path).unwrap();
        // Valid first line preserved; truncated tail silently skipped.
        assert_eq!(records.len(), 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_missing_file_returns_empty() {
        let path = tmp_path();
        let records = Reader::read_all(&path).unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn writer_creates_parent_dir() {
        let root = tmp_path();
        let nested = root.join("a/b/transcript.jsonl");
        let _ = Writer::open(&nested).unwrap();
        assert!(nested.exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
