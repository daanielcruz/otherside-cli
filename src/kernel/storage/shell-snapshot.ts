import { existsSync } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellSnapshotsDir } from "@/kernel/std/fs/paths.ts";
import { isWindows } from "@/kernel/std/proc/platform.ts";
import { findShell } from "@/kernel/std/proc/shell.ts";

const SNAPSHOT_CREATION_TIMEOUT_MS = 10_000;
const MAX_SNAPSHOT_BUFFER_BYTES = 1_048_576;
const HEAD_LINE_CAP = 1000;

type ShellType = "zsh" | "bash" | "sh";

let cleanupRegistered = false;
let cachedSnapshotPromise: Promise<string | null> | null = null;
let currentSnapshotPath: string | null = null;

function debugLog(message: string): void {
  if (process.env.OTHERSIDE_DEBUG_SHELL === "1") {
    process.stderr.write(`[shell-snapshot] ${message}\n`);
  }
}

function classifyShell(shellPath: string): ShellType {
  if (shellPath.includes("zsh")) return "zsh";
  if (shellPath.includes("bash")) return "bash";
  return "sh";
}

function getConfigFile(shellPath: string): string {
  const fileName = shellPath.includes("zsh")
    ? ".zshrc"
    : shellPath.includes("bash")
      ? ".bashrc"
      : ".profile";
  return join(homedir(), fileName);
}

function shellQuote(s: string): string {
  const sanitized = s.replace(/[\x00-\x1F\x7F]/g, "");
  return `'${sanitized.replace(/'/g, "'\\''")}'`;
}

function buildUserSnapshotContent(configFile: string): string {
  const isZsh = configFile.endsWith(".zshrc");
  const functionsBlock = isZsh
    ? [
        'echo "# Functions" >> "$SNAPSHOT_FILE"',
        "typeset -f > /dev/null 2>&1",
        "typeset +f | grep -vE '^_[^_]' | while read func; do",
        '  typeset -f "$func" >> "$SNAPSHOT_FILE"',
        "done",
      ].join("\n")
    : [
        'echo "# Functions" >> "$SNAPSHOT_FILE"',
        "declare -f > /dev/null 2>&1",
        "declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do",
        '  encoded_func=$(declare -f "$func" | base64)',
        // The emitted payload must ride inside single quotes: GNU base64 wraps
        // at 76 columns, and an unquoted multiline expansion would split the
        // eval across lines when the snapshot is sourced.
        '  echo "eval \\"\\$(echo \'$encoded_func\' | base64 -d)\\" > /dev/null 2>&1" >> "$SNAPSHOT_FILE"',
        "done",
      ].join("\n");

  const optionsBlock = isZsh
    ? [
        'echo "# Shell Options" >> "$SNAPSHOT_FILE"',
        `setopt | sed 's/^/setopt /' | head -n ${HEAD_LINE_CAP} >> "$SNAPSHOT_FILE"`,
      ].join("\n")
    : [
        'echo "# Shell Options" >> "$SNAPSHOT_FILE"',
        `shopt -p | head -n ${HEAD_LINE_CAP} >> "$SNAPSHOT_FILE"`,
        `set -o | grep "on" | awk '{print "set -o " $1}' | head -n ${HEAD_LINE_CAP} >> "$SNAPSHOT_FILE"`,
        'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"',
      ].join("\n");

  const aliasesBlock = [
    'echo "# Aliases" >> "$SNAPSHOT_FILE"',
    'if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then',
    `  alias | grep -v "='winpty " | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n ${HEAD_LINE_CAP} >> "$SNAPSHOT_FILE"`,
    "else",
    `  alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n ${HEAD_LINE_CAP} >> "$SNAPSHOT_FILE"`,
    "fi",
  ].join("\n");

  return [functionsBlock, optionsBlock, aliasesBlock].join("\n\n");
}

function buildEmbeddedSnapshotContent(): string {
  const pathValue = process.env.PATH ?? "";
  return `echo "export PATH=${shellQuote(pathValue)}" >> "$SNAPSHOT_FILE"`;
}

function buildSnapshotScript(
  shellPath: string,
  snapshotFilePath: string,
  configFileExists: boolean,
): string {
  const configFile = getConfigFile(shellPath);
  const isZsh = configFile.endsWith(".zshrc");
  const userContent = configFileExists
    ? buildUserSnapshotContent(configFile)
    : !isZsh
      ? 'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"'
      : "";
  const embeddedContent = buildEmbeddedSnapshotContent();
  return [
    `SNAPSHOT_FILE=${shellQuote(snapshotFilePath)}`,
    configFileExists ? `source "${configFile}" < /dev/null` : "# No user config file",
    'echo "# Otherside shell snapshot" >| "$SNAPSHOT_FILE"',
    'echo "# Unset all aliases to avoid conflicts with functions" >> "$SNAPSHOT_FILE"',
    'echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"',
    userContent,
    embeddedContent,
    'if [ ! -f "$SNAPSHOT_FILE" ]; then',
    '  echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2',
    "  exit 1",
    "fi",
  ].join("\n");
}

function registerCleanupOnce(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = (): void => {
    const snapshotPath = currentSnapshotPath;
    if (snapshotPath === null) return;
    try {
      if (existsSync(snapshotPath)) {
        require("node:fs").unlinkSync(snapshotPath);
      }
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("SIGHUP", () => {
    cleanup();
    process.exit(129);
  });
}

async function runSnapshotScript(
  shellPath: string,
  script: string,
): Promise<{ ok: boolean; stderr: string }> {
  try {
    const child = Bun.spawn([shellPath, "-c", "-l", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SHELL: shellPath,
        GIT_EDITOR: "true",
        OTHERSIDE: "1",
      },
    });
    const readAbort = new AbortController();
    let killer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<{ timedOut: true }>((resolve) => {
      killer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        readAbort.abort();
        resolve({ timedOut: true });
      }, SNAPSHOT_CREATION_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([
        Promise.all([
          child.exited,
          readCapped(child.stderr, MAX_SNAPSHOT_BUFFER_BYTES, readAbort.signal),
        ]).then(([exit, stderrBytes]) => ({ timedOut: false as const, exit, stderrBytes })),
        timedOut,
      ]);
      if (outcome.timedOut) return { ok: false, stderr: "" };
      const stderr = new TextDecoder().decode(outcome.stderrBytes);
      const ok = typeof outcome.exit === "number" && outcome.exit === 0;
      return { ok, stderr };
    } finally {
      if (killer !== null) clearTimeout(killer);
    }
  } catch (err) {
    debugLog(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, stderr: "" };
  }
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } catch {}
  }
  const out = new Uint8Array(Math.min(total, cap));
  let pos = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, cap - pos);
    if (take <= 0) break;
    out.set(c.subarray(0, take), pos);
    pos += take;
  }
  return out;
}

async function createSnapshot(): Promise<string | null> {
  if (isWindows()) {
    debugLog("windows path not supported yet, snapshot skipped");
    return null;
  }
  const shellPath = findShell() ?? "/bin/sh";
  const shellType: ShellType = classifyShell(shellPath);
  if (shellType === "sh") {
    debugLog(`unsupported shell type for snapshot: ${shellPath}`);
    return null;
  }
  const configFile = getConfigFile(shellPath);
  const configFileExists = existsSync(configFile);
  const snapshotsDir = shellSnapshotsDir();
  await mkdir(snapshotsDir, { recursive: true });
  const snapshotPath = join(snapshotsDir, `snapshot-${shellType}-${process.pid}.sh`);
  const script = buildSnapshotScript(shellPath, snapshotPath, configFileExists);
  debugLog(
    `creating ${shellType} snapshot at ${snapshotPath} (configFileExists=${configFileExists})`,
  );
  const { ok, stderr } = await runSnapshotScript(shellPath, script);
  if (!ok) {
    debugLog(`snapshot creation failed; stderr=${stderr.slice(0, 500)}`);
    try {
      await unlink(snapshotPath);
    } catch {}
    return null;
  }
  try {
    const info = await stat(snapshotPath);
    debugLog(`snapshot created successfully (${info.size} bytes)`);
  } catch {
    debugLog("snapshot file missing after creation");
    return null;
  }
  currentSnapshotPath = snapshotPath;
  registerCleanupOnce();
  return snapshotPath;
}

export function getShellSnapshotPath(): Promise<string | null> {
  const pending = cachedSnapshotPromise;
  if (pending !== null) {
    return pending.then((path) => {
      if (path !== null && !existsSync(path)) {
        if (cachedSnapshotPromise === pending) {
          cachedSnapshotPromise = null;
          currentSnapshotPath = null;
        }
        return getShellSnapshotPath();
      }
      return path;
    });
  }
  cachedSnapshotPromise = createSnapshot().catch((err) => {
    debugLog(`unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  return cachedSnapshotPromise;
}

export function resetShellSnapshotForTests(): void {
  cachedSnapshotPromise = null;
  cleanupRegistered = false;
  currentSnapshotPath = null;
}
