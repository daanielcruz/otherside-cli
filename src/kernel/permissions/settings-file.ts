import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SettingsPermissionsBlock } from "@/kernel/permissions/types.ts";
import { atomicWriteFileSync, mkdirSecure } from "@/kernel/std/fs/secure-fs.ts";

const SETTINGS_DIR_MODE = 0o755;

export function permissionsBlockFrom(value: unknown): SettingsPermissionsBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as SettingsPermissionsBlock) };
}

export function readSettingsFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Writes the JSON whole or not at all, creating its directory when missing. */
export function atomicWriteJson(
  filePath: string,
  data: Record<string, unknown>,
  mode: number,
): void {
  mkdirSecure(dirname(filePath), SETTINGS_DIR_MODE);
  atomicWriteFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, mode);
}
