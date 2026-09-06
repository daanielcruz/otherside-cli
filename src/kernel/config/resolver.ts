import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigSync, type UserConfig } from "@/kernel/config/config.ts";
import { SETTING_REGISTRY } from "@/kernel/config/registry.ts";
import {
  projectSettingsPath,
  readScopeRaw,
  SCOPE_PRECEDENCE,
  type SettingScope,
} from "@/kernel/config/scope.ts";
import { systemPolicyDir } from "@/kernel/permissions/persist.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

export type ManagedPolicyErrorCode = "unreadable" | "invalid-policy" | "invalid-enabled-plugins";

export class ManagedPolicyError extends Error {
  readonly code: ManagedPolicyErrorCode;
  readonly path: string;

  constructor({
    code,
    path,
    cause,
  }: {
    code: ManagedPolicyErrorCode;
    path: string;
    cause?: unknown;
  }) {
    const detail =
      code === "unreadable"
        ? "cannot be read"
        : code === "invalid-enabled-plugins"
          ? 'contains an invalid "enabledPlugins" value'
          : "is not a valid JSON policy object";
    super(
      `Managed policy file "${path}" ${detail}. ` +
        "Repair or remove the file before starting Otherside.",
      { cause },
    );
    this.name = "ManagedPolicyError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Resolve the effective config for a working directory by folding every scope's
 * raw settings file over the user base, per each setting's registry descriptor:
 * later scopes override (or set-union) earlier ones, and `policy` is a read-only
 * ceiling because it sits last in SCOPE_PRECEDENCE. The user base is already
 * normalized + migrated by loadConfigSync; project/local/session values are
 * validated per-key, while managed policy failures stop resolution.
 */
export function resolveConfig(cwd: string, sessionOverride?: Partial<UserConfig>): UserConfig {
  const result = { ...loadConfigSync() };

  const rawByScope: Record<Exclude<SettingScope, "user">, Record<string, unknown>> = {
    project: readScopeRaw(projectSettingsPath(cwd, "project")),
    local: readScopeRaw(projectSettingsPath(cwd, "local")),
    session: (sessionOverride ?? {}) as Record<string, unknown>,
    policy: readPolicyRaw(),
  };

  for (const scope of SCOPE_PRECEDENCE) {
    if (scope === "user") continue;
    const raw = rawByScope[scope];
    if (Object.keys(raw).length === 0) continue;

    for (const desc of SETTING_REGISTRY) {
      if (!desc.scopes.includes(scope)) continue;
      const rawVal = raw[desc.key];
      if (rawVal === undefined) continue;
      const validated = desc.validate ? desc.validate(rawVal) : rawVal;
      if (validated === undefined) continue;

      const target = result as Record<string, unknown>;
      if (desc.merge === "union" && Array.isArray(validated)) {
        const existing = (target[desc.key] as unknown[] | undefined) ?? [];
        target[desc.key] = [...new Set([...existing, ...validated])];
      } else if (desc.merge === "map-override") {
        const existing = (target[desc.key] as Record<string, unknown> | undefined) ?? {};
        target[desc.key] = { ...existing, ...(validated as Record<string, unknown>) };
      } else if (desc.merge === "map-append") {
        target[desc.key] = appendMapOfLists(target[desc.key], validated);
      } else {
        target[desc.key] = validated;
      }
    }
  }

  return result;
}

/**
 * Fold a map-of-arrays scope value onto the accumulated one: entries for a key
 * present in both are concatenated, lower scope first, so nothing is replaced.
 */
function appendMapOfLists(existing: unknown, incoming: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  if (!isPlainObject(incoming)) return out;
  for (const [key, value] of Object.entries(incoming)) {
    if (!Array.isArray(value)) continue;
    const current = out[key];
    out[key] = Array.isArray(current) ? [...current, ...value] : [...value];
  }
  return out;
}

/**
 * Where managed policy is read from, lowest precedence first: a file plus a
 * drop-in directory whose `.json` entries merge in sorted order, once under the
 * config root and once under the system policy directory.
 */
export function policySettingsSources(): { file: string; dropDir: string }[] {
  return [configRoot(), systemPolicyDir()].map((dir) => ({
    file: join(dir, MANAGED_SETTINGS_FILE),
    dropDir: join(dir, MANAGED_SETTINGS_DROP_DIR),
  }));
}

const MANAGED_SETTINGS_FILE = "managed-settings.json";
const MANAGED_SETTINGS_DROP_DIR = "managed-settings.d";

function readPolicyRaw(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const source of policySettingsSources()) {
    mergeJsonFile(out, source.file);
    mergeDropDir(out, source.dropDir);
  }
  return out;
}

function mergeJsonFile(target: Record<string, unknown>, path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPath(error)) return;
    throw new ManagedPolicyError({ code: "unreadable", path, cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ManagedPolicyError({ code: "invalid-policy", path, cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new ManagedPolicyError({ code: "invalid-policy", path });
  }
  mergePolicyValues(target, parsed, path);
}

function mergePolicyValues(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === "enabledPlugins") {
      validateManagedEnabledPlugins(value, path);
    }
    const descriptor = SETTING_REGISTRY.find((candidate) => candidate.key === key);
    if (descriptor?.scopes.includes("policy") && descriptor.merge === "map-override") {
      const existing = target[key];
      target[key] = {
        ...(isPlainObject(existing) ? existing : {}),
        ...(value as Record<string, unknown>),
      };
      continue;
    }
    if (descriptor?.scopes.includes("policy") && descriptor.merge === "map-append") {
      target[key] = appendMapOfLists(target[key], value);
      continue;
    }
    target[key] = value;
  }
}

function validateManagedEnabledPlugins(value: unknown, path: string): void {
  if (
    !isPlainObject(value) ||
    Object.values(value).some((enabled) => typeof enabled !== "boolean")
  ) {
    throw new ManagedPolicyError({ code: "invalid-enabled-plugins", path });
  }
}

function mergeDropDir(target: Record<string, unknown>, dir: string): void {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch (error) {
    if (isMissingPath(error)) return;
    throw new ManagedPolicyError({ code: "unreadable", path: dir, cause: error });
  }
  for (const file of files) mergeJsonFile(target, join(dir, file));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
