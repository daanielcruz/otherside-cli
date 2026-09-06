import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { isWindows } from "./platform.ts";

let cachedShell: string | null = null;
let cachedShellProbed = false;

const WINDOWS_GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];

function windowsCmdPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return `${systemRoot}\\System32\\cmd.exe`;
}

const POSIX_SYSTEM_BIN_DIRS = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"];

export function resolveTrustedExecutable(name: string): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
  for (const dir of [...POSIX_SYSTEM_BIN_DIRS, ...pathDirs]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const WINDOWS_POSIX_SHELL_NAMES = new Set([
  "ash.exe",
  "bash.exe",
  "dash.exe",
  "ksh.exe",
  "sh.exe",
  "zsh.exe",
]);

function isWindowsPosixShell(shellPath: string): boolean {
  const executable = shellPath.split(/[\\/]/).at(-1)?.toLowerCase();
  return executable !== undefined && WINDOWS_POSIX_SHELL_NAMES.has(executable);
}

function isBashOrZsh(shellPath: string): boolean {
  const executable = basename(shellPath).toLowerCase();
  return executable.includes("bash") || executable.includes("zsh");
}

function detectShell(): string | null {
  const configuredShell = process.env.SHELL;
  if (
    configuredShell &&
    existsSync(configuredShell) &&
    (isWindows() ? isWindowsPosixShell(configuredShell) : isBashOrZsh(configuredShell))
  ) {
    return configuredShell;
  }
  if (!isWindows()) return "/bin/sh";
  for (const candidate of WINDOWS_GIT_BASH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function findShell(): string | null {
  if (cachedShellProbed) return cachedShell;
  cachedShellProbed = true;
  cachedShell = detectShell();
  return cachedShell;
}

export function resetShellCache(): void {
  cachedShellProbed = false;
  cachedShell = null;
}

export function shellCommand(command: string, opts?: { login?: boolean }): string[] {
  if (!isWindows()) {
    const sh = findShell() ?? "/bin/sh";
    return [sh, opts?.login ? "-lc" : "-c", command];
  }
  const sh = findShell();
  if (sh) return [sh, opts?.login ? "-lc" : "-c", command];
  return [windowsCmdPath(), "/c", command];
}

export function bashCommand(command: string, opts?: { login?: boolean }): string[] {
  if (!isWindows()) return ["bash", opts?.login ? "-lc" : "-c", command];
  const sh = findShell();
  if (sh) return [sh, opts?.login ? "-lc" : "-c", command];
  return [windowsCmdPath(), "/c", command];
}

export const EMBEDDED_SEARCH_TOOLS_ENV = "OTHERSIDE_EMBEDDED_SEARCH_TOOLS";

function readEmbeddedSearchOptIn(): boolean {
  const raw = process.env[EMBEDDED_SEARCH_TOOLS_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function shellHasEmbeddedSearchTools(): boolean {
  return readEmbeddedSearchOptIn();
}

const DISABLE_EXTGLOB_BASH = "shopt -u extglob 2>/dev/null || true";
const DISABLE_EXTGLOB_ZSH = "setopt NO_EXTENDED_GLOB 2>/dev/null || true";

export function extglobDisableCommand(shellPath: string): string | null {
  if (shellPath.includes("bash")) return DISABLE_EXTGLOB_BASH;
  if (shellPath.includes("zsh")) return DISABLE_EXTGLOB_ZSH;
  return null;
}
