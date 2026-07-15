import { existsSync, readFileSync } from "node:fs";
import { release as osRelease } from "node:os";

export type Platform = "macos" | "windows" | "wsl" | "linux" | "unknown";

let cachedPlatform: Platform | null = null;
let cachedWslVersion: string | null | undefined;
let cachedMacOSMajor: number | null | undefined;

function detect(): Platform {
  try {
    if (process.platform === "darwin") return "macos";
    if (process.platform === "win32") return "windows";
    if (process.platform === "linux") {
      try {
        if (existsSync("/proc/version")) {
          const v = readFileSync("/proc/version", "utf8").toLowerCase();
          if (v.includes("microsoft") || v.includes("wsl")) return "wsl";
        }
      } catch {}
      return "linux";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function getPlatform(): Platform {
  if (cachedPlatform == null) cachedPlatform = detect();
  return cachedPlatform;
}

export function isWindows(): boolean {
  return getPlatform() === "windows";
}

export function isWsl(): boolean {
  return getPlatform() === "wsl";
}

export function isPosix(): boolean {
  const p = getPlatform();
  return p === "macos" || p === "linux" || p === "wsl";
}

export function getWslVersion(): string | undefined {
  if (cachedWslVersion !== undefined) return cachedWslVersion ?? undefined;
  if (process.platform !== "linux") {
    cachedWslVersion = null;
    return undefined;
  }
  try {
    const v = readFileSync("/proc/version", "utf8");
    const m = v.match(/WSL(\d+)/i);
    if (m?.[1]) {
      cachedWslVersion = m[1];
      return m[1];
    }
    if (v.toLowerCase().includes("microsoft")) {
      cachedWslVersion = "1";
      return "1";
    }
  } catch {}
  cachedWslVersion = null;
  return undefined;
}

export function getMacOSMajorVersion(): number | undefined {
  if (cachedMacOSMajor !== undefined) return cachedMacOSMajor ?? undefined;
  if (process.platform !== "darwin") {
    cachedMacOSMajor = null;
    return undefined;
  }
  const [major] = osRelease().split(".");
  const n = Number(major);
  cachedMacOSMajor = Number.isFinite(n) ? n : null;
  return cachedMacOSMajor ?? undefined;
}

export function resetPlatformCache(): void {
  cachedPlatform = null;
  cachedWslVersion = undefined;
  cachedMacOSMajor = undefined;
}
