import { basename } from "node:path";

async function isGitRepo(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

async function getBranch(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? stdout.trim() : "HEAD";
  } catch {
    return "HEAD";
  }
}

async function getDefaultBranch(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    let remoteHead = "";
    if (code === 0) {
      remoteHead = stdout.trim().replace(/^origin\//, "");
    }
    const candidates = remoteHead ? [remoteHead, "main", "master"] : ["main", "master"];
    for (const candidate of candidates) {
      const procVerify = Bun.spawn(
        ["git", "show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const verifyCode = await procVerify.exited;
      if (verifyCode === 0) {
        return candidate;
      }
    }
    for (const candidate of ["main", "master"]) {
      const procVerifyLocal = Bun.spawn(
        ["git", "show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const verifyLocalCode = await procVerifyLocal.exited;
      if (verifyLocalCode === 0) {
        return candidate;
      }
    }
    return "main";
  } catch {
    return "main";
  }
}

async function getStatus(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "--no-optional-locks", "status", "--short"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    return stdout.trim();
  } catch {
    return "";
  }
}

async function getLog(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "--no-optional-locks", "log", "--oneline", "-n", "5"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    return stdout.trim();
  } catch {
    return "";
  }
}

async function getUserName(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "config", "user.name"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? stdout.trim() : "";
  } catch {
    return "";
  }
}

function getShellName(): string {
  const shell = process.env.SHELL || "unknown";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  try {
    return basename(shell);
  } catch {
    return shell;
  }
}

async function collectGitStatus(): Promise<string | null> {
  try {
    const isGit = await isGitRepo();
    if (!isGit) return null;

    const [branch, mainBranch, status, log, userName] = await Promise.all([
      getBranch(),
      getDefaultBranch(),
      getStatus(),
      getLog(),
      getUserName(),
    ]);

    const truncatedStatus =
      status.length > 2000
        ? status.substring(0, 2000) +
          `\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${getShellName()})`
        : status;

    const parts = [
      "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
      `Current branch: ${branch}`,
      `Main branch (you will usually use this for PRs): ${mainBranch}`,
    ];

    if (userName) {
      parts.push(`Git user: ${userName}`);
    }

    parts.push(`Status:\n${truncatedStatus || "(clean)"}`);
    parts.push(`Recent commits:\n${log}`);

    return parts.join("\n\n");
  } catch {
    return null;
  }
}

let gitStatusPromise: Promise<string | null> | null = null;

export function sessionGitStatus(): Promise<string | null> {
  if (!gitStatusPromise) {
    gitStatusPromise = collectGitStatus();
  }
  return gitStatusPromise;
}
