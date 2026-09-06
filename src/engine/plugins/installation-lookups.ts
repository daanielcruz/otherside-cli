import { resolve } from "node:path";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import {
  canonicalProjectPath,
  isPluginId,
  type PluginId,
  type PluginInstallScope,
  parseInstallationId,
} from "./identity.ts";
import {
  type PluginInstallation,
  PluginLookupError,
  type PluginLookupOptions,
  type PluginLookupResult,
} from "./installation-records.ts";
import { listPluginInstallations } from "./installation-registry.ts";

function lookupFailure(
  target: string,
  code: "PLUGIN_NOT_FOUND" | "PLUGIN_AMBIGUOUS",
  candidates: readonly PluginId[] = [],
): PluginLookupResult {
  return { ok: false, code, target, candidates };
}

function relevantInstallations(
  installations: readonly PluginInstallation[],
  currentProjectPath: string,
): PluginInstallation[] {
  return installations.filter(
    (entry) =>
      entry.scope === "user" ||
      (entry.projectPath !== undefined &&
        canonicalProjectPath(entry.projectPath) === currentProjectPath),
  );
}

function selectInstallation(
  matches: readonly PluginInstallation[],
): PluginInstallation | undefined {
  const rank: Record<PluginInstallScope, number> = { local: 3, project: 2, user: 1 };
  const highestRank = Math.max(...matches.map((entry) => rank[entry.scope]!));
  const highest = matches.filter((entry) => rank[entry.scope] === highestRank);
  return highest.length === 1 ? highest[0] : undefined;
}

export function lookupPluginInstallation(
  target: string,
  options?: PluginLookupOptions,
): PluginLookupResult {
  const currentProjectPath = canonicalProjectPath(options?.cwd ?? getTrackedCwd())!;
  const installations = relevantInstallations(listPluginInstallations(), currentProjectPath).filter(
    (entry) => options?.scope === undefined || entry.scope === options.scope,
  );
  if (parseInstallationId(target)) {
    const matches = installations.filter((entry) => entry.installationId === target);
    if (matches.length === 1) {
      return { ok: true, installation: matches[0]!, pluginId: matches[0]!.identity };
    }
    if (matches.length > 1) {
      return lookupFailure(
        target,
        "PLUGIN_AMBIGUOUS",
        matches.map((entry) => entry.identity),
      );
    }
    return lookupFailure(target, "PLUGIN_NOT_FOUND");
  }
  if (isPluginId(target)) {
    const matches = installations.filter((entry) => entry.identity === target);
    const selected = selectInstallation(matches);
    if (selected) return { ok: true, installation: selected, pluginId: target };
    if (matches.length > 1) {
      return lookupFailure(
        target,
        "PLUGIN_AMBIGUOUS",
        matches.map((entry) => entry.identity),
      );
    }
    return lookupFailure(target, "PLUGIN_NOT_FOUND");
  }
  if (target.includes("@")) return lookupFailure(target, "PLUGIN_NOT_FOUND");
  const matchesById = new Map<PluginId, PluginInstallation[]>();
  for (const installation of installations) {
    if (installation.pluginName !== target) continue;
    const matches = matchesById.get(installation.identity) ?? [];
    matches.push(installation);
    matchesById.set(installation.identity, matches);
  }
  const candidateIds = [...matchesById.keys()].sort();
  if (candidateIds.length === 0) return lookupFailure(target, "PLUGIN_NOT_FOUND");
  if (candidateIds.length !== 1) return lookupFailure(target, "PLUGIN_AMBIGUOUS", candidateIds);
  const matches = matchesById.get(candidateIds[0]!)!;
  const selected = selectInstallation(matches);
  if (selected) return { ok: true, installation: selected, pluginId: candidateIds[0]! };
  return lookupFailure(target, "PLUGIN_AMBIGUOUS", candidateIds);
}

export function resolvePluginInstallation(
  target: string,
  options?: PluginLookupOptions,
): PluginLookupResult {
  return lookupPluginInstallation(target, options);
}

export function findPluginInstallation(
  target: string,
  options?: PluginLookupOptions,
): PluginInstallation | undefined {
  const result = lookupPluginInstallation(target, options);
  return result.ok ? result.installation : undefined;
}

export function findPluginInstallationByPath(path: string): PluginInstallation | undefined {
  const resolved = resolve(path);
  const matches = listPluginInstallations().filter(
    (entry) => resolve(entry.installPath) === resolved,
  );
  if (matches.length > 1) {
    throw new PluginLookupError(
      "PLUGIN_AMBIGUOUS",
      path,
      matches.map((entry) => entry.identity),
    );
  }
  return matches[0];
}

export function pluginIdentity(target: string, options?: PluginLookupOptions): string {
  if (isPluginId(target)) return target;
  const result = lookupPluginInstallation(target, options);
  if (!result.ok) {
    throw new PluginLookupError(result.code, result.target, result.candidates);
  }
  return result.pluginId;
}
