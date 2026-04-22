use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::error::Result;

#[derive(Debug, Clone, Default)]
pub struct SweepReport {
    pub scanned: usize,
    pub deleted: Vec<String>,
    pub skipped_errors: Vec<String>,
}

/// Walk `<config_dir>/projects/*/*.jsonl` and delete transcripts whose
/// modification time is older than `retention_days`. Matches the upstream
/// one-JSONL-per-session layout (`utils/sessionStoragePortable.ts:329`).
pub fn sweep(config_dir: &Path, retention_days: u64) -> Result<SweepReport> {
    let root = super::paths::projects_root(config_dir);
    let mut report = SweepReport::default();
    if retention_days == 0 {
        return Ok(report);
    }
    if !root.exists() {
        return Ok(report);
    }
    let now = SystemTime::now();
    let threshold = Duration::from_secs(retention_days * 86_400);

    let project_entries = match std::fs::read_dir(&root) {
        Ok(it) => it,
        Err(e) => {
            report.skipped_errors.push(e.to_string());
            return Ok(report);
        }
    };

    for project_entry in project_entries {
        let project_entry = match project_entry {
            Ok(e) => e,
            Err(e) => {
                report.skipped_errors.push(e.to_string());
                continue;
            }
        };
        if !project_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let project_dir = project_entry.path();
        let transcripts = match std::fs::read_dir(&project_dir) {
            Ok(it) => it,
            Err(e) => {
                report.skipped_errors.push(format!(
                    "{}: {}",
                    project_entry.file_name().to_string_lossy(),
                    e
                ));
                continue;
            }
        };
        for transcript_entry in transcripts {
            let transcript_entry = match transcript_entry {
                Ok(e) => e,
                Err(e) => {
                    report.skipped_errors.push(e.to_string());
                    continue;
                }
            };
            if !transcript_entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = transcript_entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            report.scanned += 1;
            let modified = transcript_entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
            if age > threshold {
                match std::fs::remove_file(&path) {
                    Ok(_) => {
                        let rel = path
                            .strip_prefix(&root)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .into_owned();
                        report.deleted.push(rel);
                    }
                    Err(e) => {
                        report.skipped_errors.push(format!(
                            "{}: {}",
                            path.to_string_lossy(),
                            e
                        ));
                    }
                }
            }
        }
    }
    Ok(report)
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
    fn sweep_keeps_fresh_transcript() {
        let root = scratch();
        let project = root.join("projects").join("-fresh");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("abc.jsonl"), b"").unwrap();
        let report = sweep(&root, 30).unwrap();
        assert_eq!(report.scanned, 1);
        assert!(report.deleted.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sweep_ignores_non_jsonl_files() {
        let root = scratch();
        let project = root.join("projects").join("-mixed");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("session.jsonl"), b"").unwrap();
        std::fs::write(project.join("notes.txt"), b"").unwrap();
        let report = sweep(&root, 30).unwrap();
        assert_eq!(report.scanned, 1, "txt file should be skipped");
        std::fs::remove_dir_all(&root).ok();
    }
}
