import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isSymlinkOutsideBoundary,
  normalizePathForSandbox,
} from "@/engine/sandbox/path-normalize.ts";
import {
  findFirstNonExistentComponent,
  findSymlinkInPath,
  hasFileAncestor,
  linuxGetMandatoryDenyPaths,
} from "./deny-paths.ts";

export interface LinuxReadConfig {
  denyOnly: string[];
  allowWithinDeny?: string[];
}

export interface LinuxWriteConfig {
  allowOnly: string[];
  denyWithinAllow?: string[];
}

export interface WrapLinuxParams {
  command: string;
  binShell?: string;
  needsNetworkRestriction?: boolean;
  readConfig?: LinuxReadConfig;
  writeConfig?: LinuxWriteConfig;
  allowAllUnixSockets?: boolean;
  allowGitConfig?: boolean;
  enableWeakerNestedSandbox?: boolean;
  bwrapPath?: string;
  mandatoryDenySearchDepth?: number;
  tmpdir?: string;
}

export interface WrapLinuxResult {
  wrapped: string;
  sandboxed: boolean;
}

const bwrapMountPoints = new Set<string>();
let activeSandboxCount = 0;
let exitHandlerRegistered = false;

function registerExitCleanupHandler(): void {
  if (exitHandlerRegistered) return;
  process.on("exit", () => cleanupBwrapMountPoints({ force: true }));
  exitHandlerRegistered = true;
}

export function cleanupBwrapMountPoints(opts?: { force?: boolean }): void {
  if (!opts?.force) {
    if (activeSandboxCount > 0) activeSandboxCount--;
    if (activeSandboxCount > 0) return;
  } else {
    activeSandboxCount = 0;
  }
  for (const mp of bwrapMountPoints) {
    try {
      const s = statSync(mp);
      if (s.isFile() && s.size === 0) unlinkSync(mp);
      else if (s.isDirectory() && readdirSync(mp).length === 0) rmdirSync(mp);
    } catch {}
  }
  bwrapMountPoints.clear();
}

function whichSync(bin: string): string | null {
  const bunGlobal = (globalThis as { Bun?: { which: (b: string) => string | null } }).Bun;
  if (bunGlobal) return bunGlobal.which(bin);
  const r = spawnSync("which", [bin], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return null;
}

function shellQuote(args: string[]): string {
  return args.map(quoteArg).join(" ");
}

function quoteArg(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface FsArgsParams {
  readConfig?: LinuxReadConfig;
  writeConfig?: LinuxWriteConfig;
  allowGitConfig: boolean;
  mandatoryDenySearchDepth: number;
}

function generateFilesystemArgs(params: FsArgsParams): string[] {
  const args: string[] = [];
  const allowedWritePaths: string[] = [];
  const denyWriteArgs: string[] = [];

  if (params.writeConfig) {
    args.push("--ro-bind", "/", "/");
    for (const pattern of params.writeConfig.allowOnly) {
      const normalized = normalizePathForSandbox(pattern);
      if (normalized.startsWith("/dev/")) continue;
      if (!existsSync(normalized)) continue;
      try {
        const resolved = realpathSync(normalized);
        const compare = normalized.replace(/\/+$/, "");
        if (resolved !== compare && isSymlinkOutsideBoundary(normalized, resolved)) continue;
      } catch {
        continue;
      }
      args.push("--bind", normalized, normalized);
      allowedWritePaths.push(normalized);
    }
    const denyPaths = [
      ...(params.writeConfig.denyWithinAllow ?? []),
      ...linuxGetMandatoryDenyPaths({
        maxDepth: params.mandatoryDenySearchDepth,
        allowGitConfig: params.allowGitConfig,
      }),
    ];
    const seenDenyWrite = new Set<string>();
    for (const pattern of denyPaths) {
      const normalized = normalizePathForSandbox(pattern);
      if (seenDenyWrite.has(normalized)) continue;
      seenDenyWrite.add(normalized);
      if (normalized.startsWith("/dev/")) continue;
      const symlinkInPath = findSymlinkInPath(normalized, allowedWritePaths);
      if (symlinkInPath) {
        denyWriteArgs.push("--ro-bind", "/dev/null", symlinkInPath);
        continue;
      }
      if (!existsSync(normalized)) {
        if (hasFileAncestor(normalized)) continue;
        let ancestor = dirname(normalized);
        while (ancestor !== "/" && !existsSync(ancestor)) ancestor = dirname(ancestor);
        const ancestorAllowed = allowedWritePaths.some(
          (p) => ancestor.startsWith(`${p}/`) || ancestor === p || normalized.startsWith(`${p}/`),
        );
        if (!ancestorAllowed) continue;
        const firstNonExistent = findFirstNonExistentComponent(normalized);
        if (firstNonExistent !== normalized) {
          const emptyDir = mkdtempSync(join(tmpdir(), "otherside-sandbox-empty-"));
          denyWriteArgs.push("--ro-bind", emptyDir, firstNonExistent);
          bwrapMountPoints.add(firstNonExistent);
          registerExitCleanupHandler();
        } else {
          denyWriteArgs.push("--ro-bind", "/dev/null", firstNonExistent);
          bwrapMountPoints.add(firstNonExistent);
          registerExitCleanupHandler();
        }
        continue;
      }
      const within = allowedWritePaths.some(
        (p) => normalized.startsWith(`${p}/`) || normalized === p,
      );
      if (within) denyWriteArgs.push("--ro-bind", normalized, normalized);
    }
  } else {
    args.push("--bind", "/", "/");
  }

  const readDenyPaths: string[] = [];
  const readAllowPaths = (params.readConfig?.allowWithinDeny ?? []).map(normalizePathForSandbox);
  const maskedFiles = new Set<string>();
  const rootSkip = new Set(["proc", "dev", "sys"]);
  for (const p of params.readConfig?.denyOnly ?? []) {
    if (normalizePathForSandbox(p) === "/") {
      for (const child of readdirSync("/")) {
        if (!rootSkip.has(child)) readDenyPaths.push(`/${child}`);
      }
    } else {
      readDenyPaths.push(p);
    }
  }
  if (existsSync("/etc/ssh/ssh_config.d")) readDenyPaths.push("/etc/ssh/ssh_config.d");
  const normalizedDenyPaths = readDenyPaths
    .map(normalizePathForSandbox)
    .sort((a, b) => a.split("/").length - b.split("/").length);

  for (const normalized of normalizedDenyPaths) {
    if (!existsSync(normalized)) continue;
    const denySep = normalized === "/" ? "/" : `${normalized}/`;
    const s = statSync(normalized);
    if (s.isDirectory()) {
      args.push("--tmpfs", normalized);
      for (const writePath of allowedWritePaths) {
        if (writePath.startsWith(denySep) || writePath === normalized) {
          args.push("--bind", writePath, writePath);
        }
      }
      for (const allowPath of readAllowPaths) {
        if (allowPath.startsWith(denySep) || allowPath === normalized) {
          if (!existsSync(allowPath)) continue;
          const writeCovers = allowedWritePaths.some(
            (w) =>
              (w.startsWith(denySep) || w === normalized) &&
              (allowPath === w || allowPath.startsWith(`${w}/`)),
          );
          if (writeCovers) continue;
          args.push("--ro-bind", allowPath, allowPath);
        }
      }
    } else {
      if (readAllowPaths.includes(normalized)) continue;
      args.push("--ro-bind", "/dev/null", normalized);
      maskedFiles.add(normalized);
    }
  }
  for (let i = 0; i < denyWriteArgs.length; i += 3) {
    const dest = denyWriteArgs[i + 2];
    if (dest === undefined || maskedFiles.has(dest)) continue;
    const arg0 = denyWriteArgs[i];
    const arg1 = denyWriteArgs[i + 1];
    if (arg0 === undefined || arg1 === undefined) continue;
    args.push(arg0, arg1, dest);
  }
  return args;
}

export function wrapCommandWithSandboxLinux(params: WrapLinuxParams): WrapLinuxResult {
  const hasReadRestrictions = !!params.readConfig && params.readConfig.denyOnly.length > 0;
  const hasWriteRestrictions = params.writeConfig !== undefined;
  const needsNetworkRestriction = params.needsNetworkRestriction === true;
  if (!needsNetworkRestriction && !hasReadRestrictions && !hasWriteRestrictions) {
    return { wrapped: params.command, sandboxed: false };
  }
  activeSandboxCount++;
  const bwrapArgs: string[] = ["--new-session", "--die-with-parent"];
  try {
    if (needsNetworkRestriction) bwrapArgs.push("--unshare-net");
    if (params.tmpdir) {
      bwrapArgs.push("--setenv", "TMPDIR", params.tmpdir);
      bwrapArgs.push("--setenv", "TMPPREFIX", `${params.tmpdir}/zsh`);
    }
    const fsArgs = generateFilesystemArgs({
      ...(params.readConfig ? { readConfig: params.readConfig } : {}),
      ...(params.writeConfig ? { writeConfig: params.writeConfig } : {}),
      allowGitConfig: params.allowGitConfig === true,
      mandatoryDenySearchDepth: params.mandatoryDenySearchDepth ?? 3,
    });
    bwrapArgs.push(...fsArgs);
    bwrapArgs.push("--dev", "/dev");
    bwrapArgs.push("--unshare-pid");
    if (!params.enableWeakerNestedSandbox) {
      bwrapArgs.push("--proc", "/proc");
    } else {
      bwrapArgs.push("--unshare-user", "--bind", "/proc", "/proc");
    }
    const shellName = params.binShell || "bash";
    const shell = whichSync(shellName);
    if (!shell) throw new Error(`Shell '${shellName}' not found in PATH`);
    bwrapArgs.push("--", shell, "-c", params.command);
    const wrapped = shellQuote([params.bwrapPath ?? "bwrap", ...bwrapArgs]);
    return { wrapped, sandboxed: true };
  } catch (error) {
    if (activeSandboxCount > 0) activeSandboxCount--;
    throw error;
  }
}

export function getLinuxDependencyStatus(opts?: { bwrapPath?: string }): {
  hasBwrap: boolean;
  hasSeccompApply: boolean;
} {
  const { bwrapPath } = opts ?? {};
  return {
    hasBwrap: bwrapPath ? isExecutable(bwrapPath) : whichSync("bwrap") !== null,
    hasSeccompApply: false,
  };
}

function isExecutable(p: string): boolean {
  try {
    const { accessSync, constants } = require("node:fs") as typeof import("node:fs");
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resetLinuxSandboxState(): void {
  bwrapMountPoints.clear();
  activeSandboxCount = 0;
}
