

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::GRACE_PERIOD_MS;

pub const MAX_CONCURRENT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ShellId(String);

impl ShellId {
    pub fn new() -> Self {
        let u = uuid::Uuid::new_v4();
        let s = u.simple().to_string();
        Self(s[..8].to_string())
    }

    pub fn from_str(s: &str) -> Self {
        Self(s.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ShellId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellStatus {
    Running,
    Exited,
}

impl ShellStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ShellStatus::Running => "running",
            ShellStatus::Exited => "exited",
        }
    }
}

#[derive(Debug)]
pub struct BackgroundShell {
    pub id: ShellId,
    pub started_at: Instant,
    stdout: Mutex<BufferState>,
    stderr: Mutex<BufferState>,
    status: Mutex<ShellStatus>,
    exit_code: Mutex<Option<i32>>,
    child: Mutex<Option<Child>>,
}

#[derive(Debug, Default)]
struct BufferState {
    buffer: String,
    cursor: usize,
}

impl BufferState {
    fn append(&mut self, s: &str) {
        self.buffer.push_str(s);
    }

    fn drain_new(&mut self) -> String {
        if self.cursor >= self.buffer.len() {
            return String::new();
        }
        let out = self.buffer[self.cursor..].to_string();
        self.cursor = self.buffer.len();
        out
    }
}

#[derive(Debug, Clone)]
pub struct PollResult {
    pub stdout: String,
    pub stderr: String,
    pub status: ShellStatus,
    pub exit_code: Option<i32>,
}

#[derive(Debug)]
pub struct ShellRegistry {
    max_concurrent: usize,
    shells: RwLock<HashMap<String, Arc<BackgroundShell>>>,
}

impl ShellRegistry {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            max_concurrent,
            shells: RwLock::new(HashMap::new()),
        }
    }

    pub fn spawn(&self, command: &str) -> std::io::Result<ShellId> {
        {
            let live = self.shells.read().unwrap();
            if live.len() >= self.max_concurrent {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!(
                        "background shell cap reached ({} concurrent)",
                        self.max_concurrent
                    ),
                ));
            }
        }

        let mut child = Command::new("sh")
            .arg("-c")
            .arg(command)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let shell_id = ShellId::new();
        let shell = Arc::new(BackgroundShell {
            id: shell_id.clone(),
            started_at: Instant::now(),
            stdout: Mutex::new(BufferState::default()),
            stderr: Mutex::new(BufferState::default()),
            status: Mutex::new(ShellStatus::Running),
            exit_code: Mutex::new(None),
            child: Mutex::new(Some(child)),
        });

        let shell_for_task = shell.clone();
        tokio::spawn(async move {
            if let Some(out) = stdout {
                let shell = shell_for_task.clone();
                tokio::spawn(async move {
                    let mut rdr = BufReader::new(out).lines();
                    while let Ok(Some(line)) = rdr.next_line().await {
                        let mut g = shell.stdout.lock().unwrap();
                        g.append(&line);
                        g.append("\n");
                    }
                });
            }
            if let Some(err) = stderr {
                let shell = shell_for_task.clone();
                tokio::spawn(async move {
                    let mut rdr = BufReader::new(err).lines();
                    while let Ok(Some(line)) = rdr.next_line().await {
                        let mut g = shell.stderr.lock().unwrap();
                        g.append(&line);
                        g.append("\n");
                    }
                });
            }

            let waiter = {
                let mut slot = shell_for_task.child.lock().unwrap();
                slot.take()
            };
            if let Some(mut ch) = waiter {
                let status = ch.wait().await;
                *shell_for_task.status.lock().unwrap() = ShellStatus::Exited;
                if let Ok(s) = status {
                    *shell_for_task.exit_code.lock().unwrap() = Some(s.code().unwrap_or(-1));
                }
            }
        });

        let mut live = self.shells.write().unwrap();
        live.insert(shell_id.0.clone(), shell);
        Ok(shell_id)
    }

    pub fn poll(&self, shell_id: &str, filter: Option<&str>) -> std::io::Result<PollResult> {
        let shell = {
            let live = self.shells.read().unwrap();
            live.get(shell_id).cloned().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("no background shell `{shell_id}`"),
                )
            })?
        };
        let stdout = {
            let mut g = shell.stdout.lock().unwrap();
            filter_opt(&g.drain_new(), filter)
        };
        let stderr = {
            let mut g = shell.stderr.lock().unwrap();
            filter_opt(&g.drain_new(), filter)
        };
        let status = *shell.status.lock().unwrap();
        let exit_code = *shell.exit_code.lock().unwrap();
        Ok(PollResult {
            stdout,
            stderr,
            status,
            exit_code,
        })
    }

    pub fn kill(&self, shell_id: &str) -> std::io::Result<()> {
        let shell = {
            let mut live = self.shells.write().unwrap();
            live.remove(shell_id).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("no background shell `{shell_id}`"),
                )
            })?
        };
        if let Some(mut child) = shell.child.lock().unwrap().take() {
            let _ = child.start_kill();
            let waiter = async move {
                let _ = tokio::time::timeout(
                    Duration::from_millis(GRACE_PERIOD_MS),
                    child.wait(),
                )
                .await;
            };
            if let Ok(h) = tokio::runtime::Handle::try_current() {
                h.spawn(waiter);
            }
        }
        *shell.status.lock().unwrap() = ShellStatus::Exited;
        Ok(())
    }

    pub fn drop_all(&self) {
        let mut live = self.shells.write().unwrap();
        for (_, shell) in live.drain() {
            if let Some(mut child) = shell.child.lock().unwrap().take() {
                let _ = child.start_kill();
            }
            *shell.status.lock().unwrap() = ShellStatus::Exited;
        }
    }

    pub fn len(&self) -> usize {
        self.shells.read().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn filter_opt(s: &str, filter: Option<&str>) -> String {
    match filter {
        None => s.to_string(),
        Some(pattern) => s
            .lines()
            .filter(|line| line.contains(pattern))
            .map(|l| format!("{l}\n"))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawn_echo_then_poll() {
        let reg = ShellRegistry::new(4);
        let id = reg.spawn("echo background").unwrap();

        tokio::time::sleep(Duration::from_millis(200)).await;
        let r = reg.poll(id.as_str(), None).unwrap();
        assert!(r.stdout.contains("background"));
    }

    #[tokio::test]
    async fn poll_clears_cursor() {
        let reg = ShellRegistry::new(4);
        let id = reg.spawn("echo one; sleep 0.1; echo two").unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let r1 = reg.poll(id.as_str(), None).unwrap();
        let r2 = reg.poll(id.as_str(), None).unwrap();
        assert!(r1.stdout.contains("one") || r1.stdout.contains("two"));

        assert!(r2.stdout.is_empty());
    }

    #[tokio::test]
    async fn max_concurrent_enforced() {
        let reg = ShellRegistry::new(2);
        let _a = reg.spawn("sleep 1").unwrap();
        let _b = reg.spawn("sleep 1").unwrap();
        let res = reg.spawn("sleep 1");
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn kill_removes_shell() {
        let reg = ShellRegistry::new(4);
        let id = reg.spawn("sleep 5").unwrap();
        assert_eq!(reg.len(), 1);
        reg.kill(id.as_str()).unwrap();
        assert!(reg.is_empty());
    }

    #[tokio::test]
    async fn filter_only_keeps_matching_lines() {
        let reg = ShellRegistry::new(4);
        let id = reg.spawn("echo foo; echo bar; echo foo2").unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let r = reg.poll(id.as_str(), Some("foo")).unwrap();
        assert!(r.stdout.contains("foo"));
        assert!(r.stdout.contains("foo2"));
        assert!(!r.stdout.contains("bar"));
    }
}
