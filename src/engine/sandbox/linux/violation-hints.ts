const DENIAL_PATTERNS: Array<{ re: RegExp; hint: string }> = [
  {
    re: /\b(Operation not permitted|EPERM)\b/,
    hint: "file-write blocked by sandbox (path outside the writable allowlist)",
  },
  {
    re: /\b(Permission denied|EACCES)\b.*\b(write|create|open|mkdir|chmod|chown|unlink|rename)\b/i,
    hint: "filesystem write blocked by sandbox",
  },
  {
    re: /\b(Read-only file system|EROFS)\b/,
    hint: "write attempt on read-only mount (sandbox root is bind-mounted ro)",
  },
  {
    re: /\b(Network is unreachable|ENETUNREACH|Could not resolve host|Temporary failure in name resolution)\b/i,
    hint: "network access blocked (sandbox uses --unshare-net)",
  },
  {
    re: /\b(socket.*Operation not permitted|seccomp.*denied|Bad system call)\b/i,
    hint: "syscall blocked by seccomp filter (Unix socket creation or similar)",
  },
];

const SANDBOX_FOOTER =
  "[sandbox] To allow these operations, either pick a path inside the writable set or re-run with dangerouslyDisableSandbox: true.";

export function annotateLinuxSandboxStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return stderr;
  const hints = new Set<string>();
  for (const { re, hint } of DENIAL_PATTERNS) {
    if (re.test(trimmed)) hints.add(hint);
  }
  if (hints.size === 0) return stderr;
  const lines = [trimmed, "", "[sandbox] likely denied operations:"];
  for (const h of hints) lines.push(`  - ${h}`);
  lines.push(SANDBOX_FOOTER);
  return lines.join("\n");
}
