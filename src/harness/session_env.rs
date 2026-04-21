pub struct UserEnvelope {
    pub email: String,
    pub current_date: String,
    pub cwd: String,
    pub is_git_repo: bool,
    pub platform: String,
    pub shell: String,
    pub os_version: String,
}

pub fn resolve() -> UserEnvelope {
    let (email, current_date) = resolve_user_context();
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "/".to_string());
    let is_git_repo = detect_git_repo(&cwd);
    let platform = detect_platform();
    let shell = detect_shell();
    let os_version = detect_os_version();
    UserEnvelope {
        email,
        current_date,
        cwd,
        is_git_repo,
        platform,
        shell,
        os_version,
    }
}

fn resolve_user_context() -> (String, String) {
    let email = std::env::var("OTHERSIDE_USER_EMAIL").unwrap_or_else(|_| "user@local".to_string());
    let date = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    (email, date)
}

fn detect_git_repo(cwd: &str) -> bool {
    let mut dir = std::path::PathBuf::from(cwd);
    loop {
        if dir.join(".git").exists() {
            return true;
        }
        if !dir.pop() {
            return false;
        }
    }
}

fn detect_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".to_string(),
        "windows" => "win32".to_string(),
        other => other.to_string(),
    }
}

fn detect_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .as_deref()
        .and_then(|s| s.rsplit('/').next())
        .map(str::to_string)
        .unwrap_or_else(|| "bash".to_string())
}

fn detect_os_version() -> String {
    std::process::Command::new("uname")
        .arg("-sr")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| std::env::consts::OS.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_user_context_uses_env_override() {
        let prev = std::env::var("OTHERSIDE_USER_EMAIL").ok();
        unsafe { std::env::set_var("OTHERSIDE_USER_EMAIL", "override@example.com") };
        let (email, _date) = resolve_user_context();
        assert_eq!(email, "override@example.com");
        match prev {
            Some(v) => unsafe { std::env::set_var("OTHERSIDE_USER_EMAIL", v) },
            None => unsafe { std::env::remove_var("OTHERSIDE_USER_EMAIL") },
        }
    }

    #[test]
    fn resolve_returns_populated_envelope() {
        let env = resolve();
        assert!(!env.email.is_empty());
        assert!(!env.current_date.is_empty());
        assert!(!env.cwd.is_empty());
        assert!(!env.platform.is_empty());
        assert!(!env.shell.is_empty());
        assert!(!env.os_version.is_empty());
    }
}
