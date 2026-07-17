import { getProviderConfig, listProviderConfigs } from "@/engine/contract/registry.ts";
import type { ParsedModelId } from "@/engine/model/types.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import { registerModelCatalogProvider } from "@/kernel/storage/model-catalog.ts";

export type { ParsedModelId };

export type CatalogModel<A = unknown> = {
  id: string;
  displayName: string;
  contextWindow: number;
  provider: ProviderId;
  supports1m?: boolean;
  supportsPdf?: boolean;
  efforts: EffortLevel[];
  defaultEffort: EffortLevel | null;
  autoCompactTokenLimit?: number;
  /** Kept out of the normal delegation routing pool; reached only by explicit ask. */
  onDemand?: boolean;
  augment?: A;
};

export type ModelEntry = CatalogModel;

export function parseModelId(id: string): ParsedModelId {
  if (id.endsWith("[1m]")) {
    return { base: id.slice(0, -4), is1m: true, raw: id };
  }
  return { base: id, is1m: false, raw: id };
}

const runtimeModels = new Map<string, ModelEntry>();

export function CATALOG(): ModelEntry[] {
  const configList = listProviderConfigs();
  return [
    ...configList.flatMap((config) => [...legacyModelsFor(config)]),
    ...runtimeModels.values(),
  ];
}

function legacyModelsFor(
  config: ReturnType<typeof listProviderConfigs>[number],
): readonly ModelEntry[] {
  if (!config.legacyModels) return [];
  return typeof config.legacyModels === "function" ? config.legacyModels() : config.legacyModels;
}

export function registerRuntimeModel(model: ModelEntry): void {
  runtimeModels.set(`${model.provider}:${model.id}`, model);
}

export function resetRuntimeModelsForTests(): void {
  runtimeModels.clear();
}

const PASSTHROUGH_CONTEXT_WINDOW = 200_000;
const GEMINI_CONTEXT_WINDOW = 1_048_576;
const GEMINI_MODEL_ID_PREFIX = "gemini";

function passthroughContextWindow(id: string): number {
  return parseModelId(id).base.startsWith(GEMINI_MODEL_ID_PREFIX)
    ? GEMINI_CONTEXT_WINDOW
    : PASSTHROUGH_CONTEXT_WINDOW;
}

export function ensureRuntimeModel(id: string, provider: ProviderId): ModelEntry {
  const found = findModel(id, provider);
  if (found) return found;
  const entry: ModelEntry = {
    id,
    displayName: id,
    contextWindow: passthroughContextWindow(id),
    provider,
    efforts: getProviderConfig(provider)?.fallbackEfforts?.levels ?? [],
    defaultEffort: getProviderConfig(provider)?.fallbackEfforts?.default ?? null,
  };
  registerRuntimeModel(entry);
  return entry;
}

function pickById(
  catalog: ModelEntry[],
  id: string,
  provider?: ProviderId,
): ModelEntry | undefined {
  if (provider) return catalog.find((m) => m.id === id && m.provider === provider);
  const matches = catalog.filter((m) => m.id === id);
  if (matches.length === 0) return undefined;
  return matches.find((m) => m.efforts.length > 0) ?? matches[0];
}

// A trailing version sequence: one or more "-<digits>" or "-<digits>.<digits>"
// groups at the end of an id (e.g. "-4-5", "-4-8", "-5.2").
const TRAILING_VERSION_RE = /(?:-\d+(?:\.\d+)?)+$/;

/**
 * Resolve a bare family shorthand (e.g. "sonnet") against an already
 * provider-scoped catalog slice. Matches when the base names exactly one
 * model — either as a mid-id segment ("-<base>-") or as the trailing segment
 * once the id's version tail is stripped ("claude-sonnet-5" → "claude-sonnet"
 * → ends with "-sonnet"). A base carrying digits (e.g. "sonnet-5") never
 * takes this path — that's the exact/suffix concern. Ambiguous (2+ matches)
 * or empty results fail exactly like an unknown model; callers already
 * report that. Callers must pre-filter `catalog` to one provider — this
 * never reasons across providers.
 */
export function findFamilyMatch(catalog: ModelEntry[], base: string): ModelEntry | undefined {
  if (/\d/.test(base)) return undefined;
  const mid = `-${base}-`;
  const tail = `-${base}`;
  const matches = catalog.filter(
    (m) => m.id.includes(mid) || m.id.replace(TRAILING_VERSION_RE, "").endsWith(tail),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function findModel(id: string, provider?: ProviderId): ModelEntry | undefined {
  const catalog = CATALOG();
  const exact = pickById(catalog, id, provider);
  if (exact) return exact;
  const base = parseModelId(id).base;
  const baseMatch = pickById(catalog, base, provider);
  if (baseMatch) return baseMatch;
  // Family shorthand is a same-provider concern only (see findFamilyMatch) —
  // skip it when no provider was given, matching the exact/base steps above
  // never guessing a provider from an ambiguous bare family name either.
  if (!provider) return undefined;
  return findFamilyMatch(
    catalog.filter((m) => m.provider === provider),
    base,
  );
}

export function resolveModelId(id: string, provider?: ProviderId): string {
  const found = findModel(id, provider);
  return found ? found.id : id;
}

export function effortLevelsForModel(id: string, provider?: ProviderId): EffortLevel[] {
  const m = findModel(id, provider);
  if (m) return m.efforts;
  if (!provider) return [];
  return getProviderConfig(provider)?.fallbackEfforts?.levels ?? [];
}

export function defaultEffortForModel(id: string, provider?: ProviderId): EffortLevel | null {
  const m = findModel(id, provider);
  if (m) return m.defaultEffort;
  if (!provider) return null;
  return getProviderConfig(provider)?.fallbackEfforts?.default ?? null;
}

export function modelsForProvider(provider: ProviderId): ModelEntry[] {
  return CATALOG().filter((m) => m.provider === provider);
}

export function availableModelsForProvider(provider: ProviderId): ModelEntry[] {
  const all = modelsForProvider(provider);
  const cfg = getProviderConfig(provider);
  const gate = cfg?.modelAvailable ?? (() => true);
  return all.filter((m) => gate(m.id));
}

export function defaultModelForProvider(provider: ProviderId): string {
  const cfg = getProviderConfig(provider);
  const raw = cfg?.defaultModelId;
  const id = typeof raw === "function" ? raw() : raw;
  if (id) return id;
  return modelsForProvider(provider)[0]?.id ?? "claude-opus-4-8";
}

export interface InitialModelInputs {
  provider: ProviderId;
  savedDefaultProvider: ProviderId;
  savedDefaultModel: string;
}

export function pickInitialModel(inputs: InitialModelInputs): string {
  const { provider, savedDefaultProvider, savedDefaultModel } = inputs;
  if (provider === savedDefaultProvider && savedDefaultModel) {
    const saved = findModel(savedDefaultModel, provider);
    if (saved && saved.provider === provider) return saved.id;
  }
  return defaultModelForProvider(provider);
}

export function modelDisplayWithContext(id: string, provider?: ProviderId): string {
  const model = findModel(id, provider);
  if (!model) return id;
  const suffix = parseModelId(id).is1m ? "1M" : compactContext(model.contextWindow);
  return `${model.displayName} · ${suffix} context`;
}

function compactContext(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

registerModelCatalogProvider({
  catalogModels: CATALOG,
  findCatalogModel: findModel,
  catalogProviderConfig: getProviderConfig,
});

export function effortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case "low":
      return "Quick, straightforward implementation with minimal overhead";
    case "medium":
      return "Balanced approach with standard implementation and testing";
    case "high":
      return "Comprehensive implementation with extensive testing and documentation";
    case "xhigh":
      return "Deeper reasoning than high, just below maximum";
    case "max":
      return "Maximum capability with deepest reasoning.";
  }
}
