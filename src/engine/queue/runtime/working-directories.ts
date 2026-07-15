import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function expandHome(directory: string): string {
  if (directory === "~") return homedir();
  if (directory.startsWith("~/")) return resolve(homedir(), directory.slice(2));
  return directory;
}

export function resolveWorkingDirectory(directory: string, cwd: string): string {
  return resolve(cwd, expandHome(directory)).normalize("NFC");
}

export function canonicalizeWorkingDirectory(directory: string, cwd: string): string | null {
  const absolute = resolveWorkingDirectory(directory, cwd);
  try {
    return statSync(absolute).isDirectory() ? absolute : null;
  } catch {
    return null;
  }
}

export function readCliWorkingDirectories(cwd: string): string[] {
  const raw = process.env.OTHERSIDE_CLI_ADD_DIRS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const directories = new Set<string>();
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      const canonical = canonicalizeWorkingDirectory(value, cwd);
      if (canonical !== null) directories.add(canonical);
    }
    return [...directories];
  } catch {
    return [];
  }
}
