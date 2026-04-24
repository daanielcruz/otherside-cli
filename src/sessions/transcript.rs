

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use super::record::Record;
use crate::error::Result;

#[derive(Debug)]
pub struct Writer {
    path: PathBuf,
    file: Option<File>,
}

impl Writer {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            path: path.to_path_buf(),
            file: None,
        })
    }

    pub fn append(&mut self, record: &Record) -> Result<()> {
        let file = match self.file.as_mut() {
            Some(f) => f,
            None => {
                if let Some(parent) = self.path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut opts = OpenOptions::new();
                opts.create(true).append(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(0o600);
                }
                let f = opts.open(&self.path)?;
                self.file = Some(f);
                self.file.as_mut().expect("file just installed")
            }
        };
        let line = record.to_line();
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_materialized(&self) -> bool {
        self.file.is_some()
    }
}

pub struct Reader;

impl Reader {
    pub fn read_all(path: &Path) -> Result<Vec<Record>> {
        if !path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(path)?;
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
            w.append(&Record::user_message(now_iso(), "hi"))
                .unwrap();
            w.append(&Record::assistant_message(now_iso(), "hello"))
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
            w.append(&Record::user_message(now_iso(), "first"))
                .unwrap();
        }

        {
            let mut f = OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(b"{\"type\":\"user_message\",\"ts\":\"").unwrap();
        }
        let records = Reader::read_all(&path).unwrap();

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
    fn writer_open_does_not_materialize_until_first_append() {
        let root = tmp_path();
        let nested = root.join("a/b/transcript.jsonl");
        let mut w = Writer::open(&nested).unwrap();
        assert!(
            !nested.exists(),
            "open must be lazy — empty sessions must not leak a zero-byte .jsonl that pollutes resume listings",
        );
        assert!(!w.is_materialized());
        w.append(&Record::user_message(
            "2026-04-24T00:00:00.000Z",
            "first real turn",
        ))
        .unwrap();
        assert!(nested.exists(), "file exists after first append");
        assert!(w.is_materialized());
        std::fs::remove_dir_all(&root).ok();
    }
}
