import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TIER_NAMES, type TierName } from "@/engine/model/tier/names.ts";
import { isProviderId, type ProviderId } from "@/kernel/config/provider-ids.ts";

export interface RosterEntry {
  provider: ProviderId;
  model: string;
}

// A tier present in an overlay REPLACES that tier's roster entirely (an
// explicit empty array disables the tier); an absent tier falls through to
// the next layer. Layering: built-in seeds ← user global ← project (wins).
export type RosterOverlay = Partial<Record<TierName, RosterEntry[]>>;

export const ORCHESTRATION_FILE_NAME = "orchestration.json";

export function userOrchestrationPath(): string {
  return join(homedir(), ".otherside", ORCHESTRATION_FILE_NAME);
}

export function projectOrchestrationPath(projectDir: string): string {
  return join(projectDir, ".otherside", ORCHESTRATION_FILE_NAME);
}

// Corrupt files and malformed entries degrade instead of throwing: a file
// that fails to parse contributes nothing, and an invalid entry is dropped
// while the rest of its tier survives.
export function parseRosterOverlay(raw: string): RosterOverlay {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const tiers = (parsed as { tiers?: unknown }).tiers;
  if (typeof tiers !== "object" || tiers === null) return {};
  const overlay: RosterOverlay = {};
  for (const tier of TIER_NAMES) {
    const list = (tiers as Record<string, unknown>)[tier];
    if (!Array.isArray(list)) continue;
    overlay[tier] = list.filter(isRosterEntry).map((entry) => ({
      provider: entry.provider,
      model: entry.model,
    }));
  }
  return overlay;
}

function isRosterEntry(value: unknown): value is RosterEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { provider?: unknown; model?: unknown };
  return (
    isProviderId(entry.provider) && typeof entry.model === "string" && entry.model.trim().length > 0
  );
}

function readOverlay(path: string): RosterOverlay {
  if (!existsSync(path)) return {};
  try {
    return parseRosterOverlay(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function mergeRosterOverlays(base: RosterOverlay, over: RosterOverlay): RosterOverlay {
  const merged: RosterOverlay = { ...base };
  for (const tier of TIER_NAMES) {
    const list = over[tier];
    if (list !== undefined) merged[tier] = list;
  }
  return merged;
}

let cachedOverlay: RosterOverlay | null = null;

// Read once per process (session start); /reload support re-reads explicitly.
export function loadRosterOverlay(projectDir: string): RosterOverlay {
  if (cachedOverlay === null) {
    cachedOverlay = mergeRosterOverlays(
      readOverlay(userOrchestrationPath()),
      readOverlay(projectOrchestrationPath(projectDir)),
    );
  }
  return cachedOverlay;
}

export function reloadRosterOverlay(projectDir: string): RosterOverlay {
  cachedOverlay = null;
  return loadRosterOverlay(projectDir);
}

export function resetRosterOverlayForTests(): void {
  cachedOverlay = null;
}

export type RosterScope = "user" | "project";

export function scopedOrchestrationPath(scope: RosterScope, projectDir: string): string {
  return scope === "user" ? userOrchestrationPath() : projectOrchestrationPath(projectDir);
}

// The overlay of ONE scope file, for editing surfaces that show which scope
// owns a tier override (the merged view hides the layering).
export function readScopedOverlay(scope: RosterScope, projectDir: string): RosterOverlay {
  return readOverlay(scopedOrchestrationPath(scope, projectDir));
}

// Writes one tier's override into the scope file (null clears the override so
// the tier falls back to the lower layer / built-in seed). Unknown top-level
// fields in the file are preserved; only `tiers.<tier>` is touched.
export function writeScopedTier(
  scope: RosterScope,
  projectDir: string,
  tier: TierName,
  entries: RosterEntry[] | null,
): void {
  const path = scopedOrchestrationPath(scope, projectDir);
  let document: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        document = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file: rewrite from scratch rather than fail the edit.
    }
  }
  const tiers =
    typeof document.tiers === "object" && document.tiers !== null
      ? (document.tiers as Record<string, unknown>)
      : {};
  if (entries === null) delete tiers[tier];
  else tiers[tier] = entries;
  document.tiers = tiers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  cachedOverlay = null;
}
