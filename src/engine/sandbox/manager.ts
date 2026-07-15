import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfigSync, type SettingsSandboxConfig } from "@/kernel/config/config.ts";
import { containsExcludedCommand } from "./excluded.ts";
import {
  cleanupBwrapMountPoints,
  getLinuxDependencyStatus,
  type LinuxReadConfig,
  type LinuxWriteConfig,
  wrapCommandWithSandboxLinux,
} from "./linux/bwrap.ts";
import { annotateLinuxSandboxStderr } from "./linux/violation-hints.ts";
import { type ReadConfig, type WriteConfig, wrapCommandWithSandboxMacOS } from "./macos.ts";
import { startSandboxMonitor, takeViolationsForLogTag } from "./monitor.ts";
import { getDefaultWritePaths } from "./path-normalize.ts";
import { scrubBareGitRepoFiles } from "./scrub.ts";
import { getSandboxTmpdir } from "./tmpdir.ts";
import { detectWorktreeMainRepoPath } from "./worktree.ts";

export type SandboxSettings = Required<
  Pick<SettingsSandboxConfig, "enabled" | "allowUnsandboxedCommands" | "autoAllowBashIfSandboxed">
> & {
  excludedCommands: string[];
  filesystem?: SettingsSandboxConfig["filesystem"];
  network?: SettingsSandboxConfig["network"];
  allowPty?: boolean;
  failIfUnavailable?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  ignoreViolations?: Record<string, string[]>;
  bwrapPath?: string;
  enableWeakerNestedSandbox?: boolean;
  mandatoryDenySearchDepth?: number;
};

const DEFAULT_SETTINGS: SandboxSettings = {
  enabled: false,
  allowUnsandboxedCommands: true,
  autoAllowBashIfSandboxed: true,
  excludedCommands: [],
};

let cachedSettings: SandboxSettings | null = null;
let cachedAvailability: boolean | null = null;

export function resetSandboxState(): void {
  cachedSettings = null;
  cachedAvailability = null;
}

function envFlag(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const lower = v.trim().toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  return undefined;
}

function readSandboxFromSettingsFile(): SettingsSandboxConfig | undefined {
  try {
    return loadConfigSync().sandbox;
  } catch {
    return undefined;
  }
}

function mergeSandboxSettings(
  base: SandboxSettings,
  override: SettingsSandboxConfig,
): SandboxSettings {
  return {
    enabled: override.enabled ?? base.enabled,
    allowUnsandboxedCommands: override.allowUnsandboxedCommands ?? base.allowUnsandboxedCommands,
    autoAllowBashIfSandboxed: override.autoAllowBashIfSandboxed ?? base.autoAllowBashIfSandboxed,
    excludedCommands: override.excludedCommands ?? base.excludedCommands,
    ...(override.filesystem
      ? { filesystem: override.filesystem }
      : base.filesystem
        ? { filesystem: base.filesystem }
        : {}),
    ...(override.network
      ? { network: override.network }
      : base.network
        ? { network: base.network }
        : {}),
    ...(override.allowPty !== undefined
      ? { allowPty: override.allowPty }
      : base.allowPty !== undefined
        ? { allowPty: base.allowPty }
        : {}),
    ...(override.failIfUnavailable !== undefined
      ? { failIfUnavailable: override.failIfUnavailable }
      : base.failIfUnavailable !== undefined
        ? { failIfUnavailable: base.failIfUnavailable }
        : {}),
    ...(override.enableWeakerNetworkIsolation !== undefined
      ? { enableWeakerNetworkIsolation: override.enableWeakerNetworkIsolation }
      : base.enableWeakerNetworkIsolation !== undefined
        ? { enableWeakerNetworkIsolation: base.enableWeakerNetworkIsolation }
        : {}),
    ...(override.ignoreViolations
      ? { ignoreViolations: override.ignoreViolations }
      : base.ignoreViolations
        ? { ignoreViolations: base.ignoreViolations }
        : {}),
    ...(override.bwrapPath
      ? { bwrapPath: override.bwrapPath }
      : base.bwrapPath
        ? { bwrapPath: base.bwrapPath }
        : {}),
    ...(override.enableWeakerNestedSandbox !== undefined
      ? { enableWeakerNestedSandbox: override.enableWeakerNestedSandbox }
      : base.enableWeakerNestedSandbox !== undefined
        ? { enableWeakerNestedSandbox: base.enableWeakerNestedSandbox }
        : {}),
    ...(override.mandatoryDenySearchDepth !== undefined
      ? { mandatoryDenySearchDepth: override.mandatoryDenySearchDepth }
      : base.mandatoryDenySearchDepth !== undefined
        ? { mandatoryDenySearchDepth: base.mandatoryDenySearchDepth }
        : {}),
  };
}

export function getSandboxSettings(): SandboxSettings {
  if (cachedSettings !== null) return cachedSettings;
  let settings: SandboxSettings = { ...DEFAULT_SETTINGS };
  const fromFile = readSandboxFromSettingsFile();
  if (fromFile) settings = mergeSandboxSettings(settings, fromFile);
  const envEnabled = envFlag("OTHERSIDE_SANDBOX_BASH");
  if (envEnabled !== undefined) settings.enabled = envEnabled;
  const envAllowUnsandboxed = envFlag("OTHERSIDE_SANDBOX_ALLOW_UNSANDBOXED");
  if (envAllowUnsandboxed !== undefined) settings.allowUnsandboxedCommands = envAllowUnsandboxed;
  cachedSettings = settings;
  return settings;
}

export function isSandboxSupportedPlatform(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export function isSandboxAvailable(): boolean {
  if (cachedAvailability !== null) return cachedAvailability;
  if (!isSandboxSupportedPlatform()) {
    cachedAvailability = false;
    return false;
  }
  if (process.platform === "darwin") {
    try {
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      cachedAvailability = existsSync("/usr/bin/sandbox-exec");
    } catch {
      cachedAvailability = false;
    }
    return cachedAvailability;
  }
  const linuxSettings = getSandboxSettings();
  const status = getLinuxDependencyStatus({
    ...(linuxSettings.bwrapPath ? { bwrapPath: linuxSettings.bwrapPath } : {}),
  });
  cachedAvailability = status.hasBwrap;
  return cachedAvailability;
}

export function isSandboxingEnabled(): boolean {
  const settings = getSandboxSettings();
  if (!settings.enabled) return false;
  return isSandboxAvailable();
}

export function areUnsandboxedCommandsAllowed(): boolean {
  return getSandboxSettings().allowUnsandboxedCommands;
}

export function isAutoAllowBashIfSandboxedEnabled(): boolean {
  return getSandboxSettings().autoAllowBashIfSandboxed;
}

function buildReadConfig(settings: SandboxSettings): ReadConfig | undefined {
  const fs = settings.filesystem;
  if (!fs?.denyRead || fs.denyRead.length === 0) return undefined;
  return {
    denyOnly: fs.denyRead,
    ...(fs.allowReadWithinDeny ? { allowWithinDeny: fs.allowReadWithinDeny } : {}),
  };
}

function buildWriteConfig(settings: SandboxSettings): WriteConfig | undefined {
  const fs = settings.filesystem;
  const allowList = fs?.allowWrite;
  const sandboxTmp = getSandboxTmpdir();
  const worktreeMain = detectWorktreeMainRepoPath();
  if (!allowList) {
    const defaults = [
      ...getDefaultWritePaths(),
      sandboxTmp,
      process.cwd(),
      join(homedir(), ".otherside"),
      ...(worktreeMain ? [worktreeMain] : []),
    ];
    return { allowOnly: defaults };
  }
  return {
    allowOnly: [...allowList, sandboxTmp, ...(worktreeMain ? [worktreeMain] : [])],
    ...(fs?.denyWriteWithinAllow ? { denyWithinAllow: fs.denyWriteWithinAllow } : {}),
  };
}

export interface ShouldSandboxInput {
  command?: string;
  dangerouslyDisableSandbox?: boolean;
}

export function shouldUseSandbox(input: ShouldSandboxInput): boolean {
  if (!isSandboxingEnabled()) return false;
  if (input.dangerouslyDisableSandbox && areUnsandboxedCommandsAllowed()) return false;
  if (!input.command) return false;
  const settings = getSandboxSettings();
  return !containsExcludedCommand(input.command, settings.excludedCommands);
}

export interface WrapResult {
  wrapped: string;
  logTag: string | null;
  tmpdir: string;
}

export function wrapWithSandbox(command: string, binShell: string): WrapResult {
  const settings = getSandboxSettings();
  if (settings.enabled && !isSandboxAvailable() && settings.failIfUnavailable === true) {
    throw new Error(
      "[sandbox] sandbox is enabled and failIfUnavailable is true, but sandbox dependencies are not available on this host",
    );
  }
  if (process.platform === "linux") return wrapWithSandboxLinuxImpl(command, binShell);
  return wrapWithSandboxMacOSImpl(command, binShell);
}

function wrapWithSandboxMacOSImpl(command: string, binShell: string): WrapResult {
  const settings = getSandboxSettings();
  const readConfig = buildReadConfig(settings);
  const writeConfig = buildWriteConfig(settings);
  const network = settings.network;
  const needsNetworkRestriction = network?.enabled === false;
  const tmpdir = getSandboxTmpdir();
  const result = wrapCommandWithSandboxMacOS(
    {
      command,
      binShell,
      needsNetworkRestriction,
      ...(readConfig ? { readConfig } : {}),
      ...(writeConfig ? { writeConfig } : {}),
      ...(network?.allowAllUnixSockets ? { allowAllUnixSockets: true } : {}),
      ...(network?.allowUnixSockets ? { allowUnixSockets: network.allowUnixSockets } : {}),
      ...(network?.allowLocalBinding ? { allowLocalBinding: true } : {}),
      ...(network?.allowMachLookup ? { allowMachLookup: network.allowMachLookup } : {}),
      ...(settings.allowPty ? { allowPty: true } : {}),
      ...(settings.filesystem?.allowGitConfig ? { allowGitConfig: true } : {}),
      ...(settings.enableWeakerNetworkIsolation ? { enableWeakerNetworkIsolation: true } : {}),
    },
    { tmpdir },
  );
  return { wrapped: result.wrapped, logTag: result.logTag, tmpdir };
}

function wrapWithSandboxLinuxImpl(command: string, binShell: string): WrapResult {
  const settings = getSandboxSettings();
  const readConfig = buildReadConfigLinux(settings);
  const writeConfig = buildWriteConfigLinux(settings);
  const network = settings.network;
  const needsNetworkRestriction = network?.enabled === false;
  const tmpdir = getSandboxTmpdir();
  const result = wrapCommandWithSandboxLinux({
    command,
    binShell,
    needsNetworkRestriction,
    tmpdir,
    ...(readConfig ? { readConfig } : {}),
    ...(writeConfig ? { writeConfig } : {}),
    ...(network?.allowAllUnixSockets ? { allowAllUnixSockets: true } : {}),
    ...(settings.filesystem?.allowGitConfig ? { allowGitConfig: true } : {}),
    ...(settings.enableWeakerNestedSandbox ? { enableWeakerNestedSandbox: true } : {}),
    ...(settings.bwrapPath ? { bwrapPath: settings.bwrapPath } : {}),
    ...(settings.mandatoryDenySearchDepth !== undefined
      ? { mandatoryDenySearchDepth: settings.mandatoryDenySearchDepth }
      : {}),
  });
  return { wrapped: result.wrapped, logTag: result.sandboxed ? "linux-sandbox" : null, tmpdir };
}

function buildReadConfigLinux(settings: SandboxSettings): LinuxReadConfig | undefined {
  const fs = settings.filesystem;
  if (!fs?.denyRead || fs.denyRead.length === 0) return undefined;
  return {
    denyOnly: fs.denyRead,
    ...(fs.allowReadWithinDeny ? { allowWithinDeny: fs.allowReadWithinDeny } : {}),
  };
}

function buildWriteConfigLinux(settings: SandboxSettings): LinuxWriteConfig | undefined {
  const fs = settings.filesystem;
  const allowList = fs?.allowWrite;
  const sandboxTmp = getSandboxTmpdir();
  const worktreeMain = detectWorktreeMainRepoPath();
  if (!allowList) {
    const defaults = [
      ...getDefaultWritePaths(),
      sandboxTmp,
      process.cwd(),
      join(homedir(), ".otherside"),
      ...(worktreeMain ? [worktreeMain] : []),
    ];
    return { allowOnly: defaults };
  }
  return {
    allowOnly: [...allowList, sandboxTmp, ...(worktreeMain ? [worktreeMain] : [])],
    ...(fs?.denyWriteWithinAllow ? { denyWithinAllow: fs.denyWriteWithinAllow } : {}),
  };
}

export function annotateStderrWithSandboxFailures(stderr: string, logTag: string | null): string {
  if (!logTag) return stderr;
  if (process.platform === "linux" && logTag === "linux-sandbox") {
    return annotateLinuxSandboxStderr(stderr);
  }
  const violations = takeViolationsForLogTag(logTag);
  if (violations.length === 0) return stderr;
  const lines: string[] = [stderr.trim(), "", "[sandbox] denied operations:"];
  const seen = new Set<string>();
  for (const v of violations) {
    if (seen.has(v.line)) continue;
    seen.add(v.line);
    lines.push(`  - ${v.line}`);
    if (seen.size >= 20) break;
  }
  lines.push(
    "[sandbox] To allow these operations, either pick a path inside the writable set or re-run with dangerouslyDisableSandbox: true.",
  );
  return lines.filter((l) => l !== "").join("\n");
}

export function ensureSandboxMonitor(): void {
  if (!isSandboxingEnabled()) return;
  const settings = getSandboxSettings();
  if (settings.ignoreViolations) {
    startSandboxMonitor({ ignoreViolations: settings.ignoreViolations });
  } else {
    startSandboxMonitor();
  }
}

export function cleanupAfterCommand(commandStartTimeMs: number): string[] {
  const scrubbed = scrubBareGitRepoFiles(process.cwd(), commandStartTimeMs);
  if (process.platform === "linux") cleanupBwrapMountPoints();
  return scrubbed;
}
