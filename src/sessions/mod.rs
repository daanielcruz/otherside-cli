

pub mod id;
pub mod paths;
pub mod record;
pub mod retention;
pub mod transcript;

pub use id::SessionId;
pub use record::Record;

use std::path::PathBuf;

use crate::error::{Error, Result};

pub struct SessionHandle {
    pub id: SessionId,
    pub transcript_path: PathBuf,
    pub writer: transcript::Writer,
}

pub fn open_new(config_dir: &std::path::Path) -> Result<SessionHandle> {
    let id = SessionId::new();
    let dir = paths::session_dir(config_dir, &id);
    std::fs::create_dir_all(&dir).map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &dir,
            std::fs::Permissions::from_mode(0o700),
        );
    }
    let transcript_path = paths::transcript_path(config_dir, &id);
    let writer = transcript::Writer::open(&transcript_path)?;
    Ok(SessionHandle {
        id,
        transcript_path,
        writer,
    })
}

pub fn resume(config_dir: &std::path::Path, id: &SessionId) -> Result<(SessionHandle, Vec<Record>)> {
    let transcript_path = paths::transcript_path(config_dir, id);
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

pub fn resume_latest(config_dir: &std::path::Path) -> Result<Option<(SessionHandle, Vec<Record>)>> {
    let root = paths::sessions_root(config_dir);
    if !root.exists() {
        return Ok(None);
    }
    let mut candidates: Vec<(std::time::SystemTime, SessionId)> = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))? {
        let entry = entry.map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))?;
        if !entry.file_type().map_err(|e: std::io::Error| Error::Other(format!("io: {e}")))?.is_dir() {
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let id = SessionId::from_hex(&name).unwrap_or_else(|| SessionId::from_hex_unchecked(&name));
        let transcript = entry.path().join("transcript.jsonl");
        let modified = std::fs::metadata(&transcript)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((modified, id));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    match candidates.into_iter().next() {
        Some((_, id)) => {
            let (handle, records) = resume(config_dir, &id)?;
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

    #[test]
    fn open_new_creates_transcript_file() {
        let root = scratch_root();
        let handle = open_new(&root).unwrap();
        assert!(handle.transcript_path.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resume_latest_none_when_empty() {
        let root = scratch_root();
        let result = resume_latest(&root).unwrap();
        assert!(result.is_none());
        std::fs::remove_dir_all(&root).ok();
    }
}
