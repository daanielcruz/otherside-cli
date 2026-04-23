
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::Result;

static TASK_OUTPUT_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn install_root(dir: PathBuf) {
    let _ = TASK_OUTPUT_ROOT.set(dir);
}

pub fn current_root() -> Option<&'static Path> {
    TASK_OUTPUT_ROOT.get().map(PathBuf::as_path)
}

pub fn task_output_path(agent_id: &str) -> Option<PathBuf> {
    current_root().map(|root| root.join("tasks").join(format!("{agent_id}.output")))
}

pub fn write_task_output(agent_id: &str, content: &str) -> Result<()> {
    let Some(path) = task_output_path(agent_id) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(content.as_bytes())?;
    file.sync_data()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "otherside_taskoutput_{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn path_has_upstream_shape_once_root_is_set() {
        
        let root = scratch_root();
        let _ = TASK_OUTPUT_ROOT.set(root.clone());

        let agent_id = "a3f2c1b4d5e6f7a8";
        let path = task_output_path(agent_id).unwrap();
        assert_eq!(path, root.join("tasks").join("a3f2c1b4d5e6f7a8.output"));
    }

    #[test]
    fn write_task_output_no_op_before_install() {
        
        let result = write_task_output("abadbead00000000", "hello");
        assert!(
            result.is_ok(),
            "write must succeed or no-op cleanly: {:?}",
            result
        );
    }
}
