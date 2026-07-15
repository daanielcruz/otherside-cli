import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMPDIR_PREFIX = "otherside";
let cachedTmpdir: string | null = null;
let cleanupRegistered = false;

function uidSuffix(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const rid = Math.random().toString(36).slice(2, 10);
  return `${uid}-${rid}`;
}

function registerCleanupOnce(path: string): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = (): void => {
    try {
      rmSync(path, { recursive: true, force: true });
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
}

export function getSandboxTmpdir(): string {
  if (cachedTmpdir !== null) return cachedTmpdir;
  const dir = join("/private/tmp", `${TMPDIR_PREFIX}-${uidSuffix()}`);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {}
  cachedTmpdir = dir;
  registerCleanupOnce(dir);
  return dir;
}
