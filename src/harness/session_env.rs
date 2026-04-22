pub struct UserEnvelope {
    pub email: String,
    pub current_date: String,
    pub cwd: String,
    pub is_git_repo: bool,
    pub platform: String,
    pub shell: String,
    pub os_version: String,
    pub memory_dir: String,
    pub git_status: String,
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
    let memory_dir = resolve_memory_dir(&cwd);
    let git_status = if is_git_repo {
        resolve_git_status(&cwd).unwrap_or_default()
    } else {
        String::new()
    };
    UserEnvelope {
        email,
        current_date,
        cwd,
        is_git_repo,
        platform,
        shell,
        os_version,
        memory_dir,
        git_status,
    }
}

const MAX_STATUS_CHARS: usize = 2000;

pub fn resolve_git_status(cwd: &str) -> Option<String> {
    let branch = git_output(cwd, &["branch", "--show-current"])?;
    let main_branch = detect_default_branch(cwd);
    let status_raw = git_output(cwd, &["--no-optional-locks", "status", "--short"])?;
    let log = git_output(cwd, &["--no-optional-locks", "log", "--oneline", "-n", "5"])?;
    let user_name = git_output(cwd, &["config", "user.name"]).unwrap_or_default();

    let truncated_status = if status_raw.len() > MAX_STATUS_CHARS {
        let mut cut = status_raw[..MAX_STATUS_CHARS].to_string();
        cut.push_str(
            "\n... (truncated because it exceeds 2k characters. If you need more information, run \"git status\" using BashTool)",
        );
        cut
    } else {
        status_raw
    };
    let status_display = if truncated_status.is_empty() {
        "(clean)".to_string()
    } else {
        truncated_status
    };

    let mut parts = vec![
        "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.".to_string(),
        format!("Current branch: {branch}"),
        format!("Main branch (you will usually use this for PRs): {main_branch}"),
    ];
    if !user_name.is_empty() {
        parts.push(format!("Git user: {user_name}"));
    }
    parts.push(format!("Status:\n{status_display}"));
    parts.push(format!("Recent commits:\n{log}"));
    Some(parts.join("\n\n"))
}

fn git_output(cwd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn detect_default_branch(cwd: &str) -> String {
    git_output(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .map(|s| s.trim_start_matches("origin/").to_string())
        .or_else(|| {
            let candidates = ["main", "master"];
            candidates.iter().find_map(|b| {
                git_output(cwd, &["rev-parse", "--verify", &format!("refs/heads/{b}")]).map(|_| (*b).to_string())
            })
        })
        .unwrap_or_else(|| "main".to_string())
}

pub fn resolve_memory_dir(cwd: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let sanitized = sanitize_path(cwd);
    format!("{home}/.otherside/projects/{sanitized}/memory/")
}

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
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
