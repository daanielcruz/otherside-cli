import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

/**
 * Expand ~ / relative / absolute path inputs to a native absolute path.
 * Relative paths resolve against `baseDir` (default: tracked session cwd).
 */
export function expandPath(inputPath: string, baseDir?: string): string {
  const actualBaseDir = baseDir ?? getTrackedCwd();
  if (typeof inputPath !== "string") {
    throw new TypeError(`Path must be a string, received ${typeof inputPath}`);
  }
  if (typeof actualBaseDir !== "string") {
    throw new TypeError(`Base directory must be a string, received ${typeof actualBaseDir}`);
  }
  if (inputPath.includes("\0") || actualBaseDir.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    return normalize(actualBaseDir).normalize("NFC");
  }
  if (trimmedPath === "~") {
    return homedir().normalize("NFC");
  }
  if (trimmedPath.startsWith("~/")) {
    return join(homedir(), trimmedPath.slice(2)).normalize("NFC");
  }
  if (isAbsolute(trimmedPath)) {
    return normalize(trimmedPath).normalize("NFC");
  }
  return resolve(actualBaseDir, trimmedPath).normalize("NFC");
}
