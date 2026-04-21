

use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Default)]
pub struct SweepReport {
    pub scanned: usize,
    pub deleted: Vec<String>,
    pub skipped_errors: Vec<String>,
}

pub fn sweep(config_dir: &Path, retention_days: u64) -> Result<SweepReport> {
    let root = super::paths::sessions_root(config_dir);
    let mut report = SweepReport::default();
    if retention_days == 0 {
        return Ok(report);
    }
    if !root.exists() {
        return Ok(report);
    }
    let now = SystemTime::now();
    let threshold = Duration::from_secs(retention_days * 86_400);

    for entry in std::fs::read_dir(&root).map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                report.skipped_errors.push(e.to_string());
                continue;
            }
        };
        if !entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        report.scanned += 1;
        let dir = entry.path();
        let newest = newest_mtime(&dir);
        let age = now
            .duration_since(newest)
            .unwrap_or(Duration::ZERO);
        if age > threshold {
            match std::fs::remove_dir_all(&dir) {
                Ok(_) => {
                    report
                        .deleted
                        .push(entry.file_name().to_string_lossy().into_owned());
                }
                Err(e) => {
                    report.skipped_errors.push(format!(
                        "{}: {}",
                        entry.file_name().to_string_lossy(),
                        e
                    ));
                }
            }
        }
    }
    Ok(report)
}

fn newest_mtime(dir: &Path) -> SystemTime {
    let mut newest = SystemTime::UNIX_EPOCH;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if let Ok(meta) = e.metadata() {
                if let Ok(m) = meta.modified() {
                    if m > newest {
                        newest = m;
                    }
                }
            }
        }
    }
    newest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "otherside_retention_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn sweep_zero_days_is_disabled() {
        let root = scratch();
        let report = sweep(&root, 0).unwrap();
        assert!(report.deleted.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sweep_empty_root_no_ops() {
        let root = scratch();
        let report = sweep(&root, 30).unwrap();
        assert_eq!(report.scanned, 0);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sweep_keeps_fresh_session() {
        let root = scratch();
        let sessions = root.join("sessions").join("fresh");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("transcript.jsonl"), b"").unwrap();
        let report = sweep(&root, 30).unwrap();
        assert_eq!(report.scanned, 1);
        assert!(report.deleted.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }
}
