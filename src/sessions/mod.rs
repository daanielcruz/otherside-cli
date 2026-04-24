pub mod id;
pub mod paths;
pub mod record;
pub mod retention;
pub mod transcript;

pub use id::SessionId;
pub use record::Record;

use std::path::{Path, PathBuf};

use crate::error::Result;

pub struct SessionHandle {
    pub id: SessionId,
    pub transcript_path: PathBuf,
    pub writer: transcript::Writer,
}

pub fn open_new(config_dir: &Path, cwd: &Path) -> Result<SessionHandle> {
    let id = SessionId::new();
    let project = paths::project_dir(config_dir, cwd);
    std::fs::create_dir_all(&project)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &project,
            std::fs::Permissions::from_mode(0o700),
        );
    }
    let transcript_path = paths::transcript_path(config_dir, cwd, &id);
    let writer = transcript::Writer::open(&transcript_path)?;
    Ok(SessionHandle {
        id,
        transcript_path,
        writer,
    })
}

pub fn resume(
    config_dir: &Path,
    cwd: &Path,
    id: &SessionId,
) -> Result<(SessionHandle, Vec<Record>)> {
    let transcript_path = paths::transcript_path(config_dir, cwd, id);
    let records = transcript::Reader::read_all(&transcript_path)?;
    let writer = transcript::Writer::open(&transcript_path)?;
    Ok((
        SessionHandle {
            id: id.clone(),
            transcript_path,
            writer,
        },
        records,
    ))
}

#[derive(Debug, Clone)]
pub struct SessionSummary {
    pub id: SessionId,
    pub modified: std::time::SystemTime,
    pub first_user_preview: Option<String>,
}

pub fn list_for_cwd(config_dir: &Path, cwd: &Path) -> Result<Vec<SessionSummary>> {
    let project = paths::project_dir(config_dir, cwd);
    if !project.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<SessionSummary> = Vec::new();
    for entry in std::fs::read_dir(&project)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let Some(stem) = name.strip_suffix(".jsonl") else {
            continue;
        };
        let Some(id) = SessionId::from_hex(stem) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let first_user_preview = sniff_first_user_message(&entry.path());
        out.push(SessionSummary {
            id,
            modified,
            first_user_preview,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

fn sniff_first_user_message(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(50).flatten() {
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("user_message") {
            return value
                .get("content")
                .and_then(|c| c.as_str())
                .map(|s| s.trim().chars().take(80).collect::<String>());
        }
    }
    None
}

pub fn resume_latest(
    config_dir: &Path,
    cwd: &Path,
) -> Result<Option<(SessionHandle, Vec<Record>)>> {
    let project = paths::project_dir(config_dir, cwd);
    if !project.exists() {
        return Ok(None);
    }
    let mut candidates: Vec<(std::time::SystemTime, SessionId)> = Vec::new();
    for entry in std::fs::read_dir(&project)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let Some(stem) = name.strip_suffix(".jsonl") else {
            continue;
        };
        let id = SessionId::from_hex(stem)
            .unwrap_or_else(|| SessionId::from_hex_unchecked(stem));
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((modified, id));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    match candidates.into_iter().next() {
        Some((_, id)) => {
            let (handle, records) = resume(config_dir, cwd, &id)?;
            Ok(Some((handle, records)))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "otherside_sessions_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn scratch_cwd() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "otherside_cwd_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn open_new_resolves_transcript_path_lazily_without_materializing_file() {
        let cfg = scratch_root();
        let cwd = scratch_cwd();
        let handle = open_new(&cfg, &cwd).unwrap();
        assert!(
            !handle.transcript_path.exists(),
            "empty session must not leak a zero-byte transcript; file materializes on first append",
        );
        let expected_parent = paths::project_dir(&cfg, &cwd);
        assert_eq!(handle.transcript_path.parent().unwrap(), expected_parent);
        let name = handle.transcript_path.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.ends_with(".jsonl"));
        std::fs::remove_dir_all(&cfg).ok();
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn resume_latest_none_when_project_absent() {
        let cfg = scratch_root();
        let cwd = scratch_cwd();
        let result = resume_latest(&cfg, &cwd).unwrap();
        assert!(result.is_none());
        std::fs::remove_dir_all(&cfg).ok();
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn list_for_cwd_returns_newest_first_with_preview() {
        let cfg = scratch_root();
        let cwd = scratch_cwd();
        let h1 = open_new(&cfg, &cwd).unwrap();
        let mut w1 = h1.writer;
        w1.append(&Record::user_message(
            "2026-04-22T00:00:00.000Z",
            "first turn — here is the user prompt",
        ))
        .unwrap();
        drop(w1);

        std::thread::sleep(std::time::Duration::from_millis(20));
        let h2 = open_new(&cfg, &cwd).unwrap();
        let mut w2 = h2.writer;
        w2.append(&Record::user_message(
            "2026-04-22T00:01:00.000Z",
            "second session prompt",
        ))
        .unwrap();
        drop(w2);

        let listed = list_for_cwd(&cfg, &cwd).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, h2.id, "newest session sorts first");
        assert_eq!(
            listed[0].first_user_preview.as_deref(),
            Some("second session prompt"),
        );
        assert!(listed[1]
            .first_user_preview
            .as_deref()
            .unwrap()
            .starts_with("first turn"));
        std::fs::remove_dir_all(&cfg).ok();
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn list_for_cwd_empty_when_project_absent() {
        let cfg = scratch_root();
        let cwd = scratch_cwd();
        assert!(list_for_cwd(&cfg, &cwd).unwrap().is_empty());
        std::fs::remove_dir_all(&cfg).ok();
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn resume_latest_scopes_to_current_cwd_only() {
        let cfg = scratch_root();
        let cwd_a = scratch_cwd();
        let cwd_b = scratch_cwd();
        let mut handle_a = open_new(&cfg, &cwd_a).unwrap();
        handle_a
            .writer
            .append(&Record::user_message("2026-04-24T00:00:00.000Z", "a"))
            .unwrap();
        let mut handle_b = open_new(&cfg, &cwd_b).unwrap();
        handle_b
            .writer
            .append(&Record::user_message("2026-04-24T00:01:00.000Z", "b"))
            .unwrap();
        let latest_a = resume_latest(&cfg, &cwd_a).unwrap().unwrap();
        assert_eq!(
            latest_a.0.transcript_path.parent().unwrap(),
            paths::project_dir(&cfg, &cwd_a)
        );
        std::fs::remove_dir_all(&cfg).ok();
        std::fs::remove_dir_all(&cwd_a).ok();
        std::fs::remove_dir_all(&cwd_b).ok();
    }
}
