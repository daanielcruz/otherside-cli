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
    fn open_new_creates_transcript_file_under_projects_slug() {
        let cfg = scratch_root();
        let cwd = scratch_cwd();
        let handle = open_new(&cfg, &cwd).unwrap();
        assert!(handle.transcript_path.exists());
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
    fn resume_latest_scopes_to_current_cwd_only() {
        let cfg = scratch_root();
        let cwd_a = scratch_cwd();
        let cwd_b = scratch_cwd();
        let _handle_a = open_new(&cfg, &cwd_a).unwrap();
        // Writing a session under cwd_b must NOT surface as "latest" for cwd_a.
        let _handle_b = open_new(&cfg, &cwd_b).unwrap();
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
