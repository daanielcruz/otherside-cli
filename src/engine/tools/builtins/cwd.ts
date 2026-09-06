import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path/posix";
import { canonicalizeCwd, startsWithDir } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

const MAINTAIN_PROJECT_WORKING_DIR_TRUTHY = ["1", "true", "yes", "on"];

export function newCwdFilePath(): string {
  return join(tmpdir(), "otherside-cwd-" + randomBytes(4).toString("hex"));
}

export function cleanupCwdFile(cwdFilePath: string | null): void {
  if (cwdFilePath === null) return;
  try {
    unlinkSync(cwdFilePath);
  } catch {}
}

export function maintainProjectWorkingDir(): boolean {
  const v = (process.env.OTHERSIDE_BASH_MAINTAIN_PROJECT_WORKING_DIR ?? "").trim().toLowerCase();
  return MAINTAIN_PROJECT_WORKING_DIR_TRUTHY.includes(v);
}

export function isWithinAllowedWorkingDir(
  candidate: string,
  originalCwd: string,
  additionalWorkingDirectories: Iterable<string> = [],
): boolean {
  const canonicalCandidate = canonicalizeCwd(candidate);
  for (const workingDirectory of [originalCwd, ...additionalWorkingDirectories]) {
    if (startsWithDir(canonicalCandidate, canonicalizeCwd(workingDirectory))) return true;
  }
  return false;
}

interface ResolveTrackedCwdInput {
  newCwd: string;
  originalCwd: string;
  maintain: boolean;
  isAllowed: (cwd: string) => boolean;
}

interface TrackedCwdResolution {
  cwd: string;
  didReset: boolean;
}

export function resolveTrackedCwd(input: ResolveTrackedCwdInput): TrackedCwdResolution {
  const { newCwd, originalCwd, maintain, isAllowed } = input;
  if (maintain) return { cwd: originalCwd, didReset: false };
  if (newCwd !== originalCwd && !isAllowed(newCwd)) {
    return { cwd: originalCwd, didReset: true };
  }
  return { cwd: newCwd, didReset: false };
}

export function appendShellResetMessage(stderr: string, originalCwd: string): string {
  return `${stderr.trim()}\nShell cwd was reset to ${originalCwd}`;
}

export function recoverCwdIfMissing(): void {
  try {
    if (existsSync(getTrackedCwd())) return;
  } catch {}
  const fallback = process.env.PWD ?? homedir();
  try {
    if (existsSync(fallback)) setTrackedCwd(fallback);
  } catch {}
}
