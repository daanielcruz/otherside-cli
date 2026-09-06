import { getProviderConfig, listProviderConfigs } from "@/engine/contract/registry.ts";
import type { ParsedModelId } from "@/engine/model/types.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
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
  const found = findModel({ provider, model: id });
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

function pickByRoute(catalog: ModelEntry[], route: ProviderModelRoute): ModelEntry | undefined {
  return catalog.find((entry) => entry.id === route.model && entry.provider === route.provider);
}

function pickUniqueById(catalog: ModelEntry[], id: string): ModelEntry | undefined {
  const matches = catalog.filter((entry) => entry.id === id);
  return matches.length === 1 ? matches[0] : undefined;
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

export function findModel(route: ProviderModelRoute): ModelEntry | undefined {
  const catalog = CATALOG();
  const exact = pickByRoute(catalog, route);
  if (exact) return exact;
  const base = parseModelId(route.model).base;
  const baseMatch = pickByRoute(catalog, { ...route, model: base });
  if (baseMatch) return baseMatch;
  return findFamilyMatch(
    catalog.filter((entry) => entry.provider === route.provider),
    base,
  );
}

export function findUniqueModel(id: string): ModelEntry | undefined {
  const catalog = CATALOG();
  const exact = pickUniqueById(catalog, id);
  if (exact) return exact;
  return pickUniqueById(catalog, parseModelId(id).base);
}

export function resolveModelId(route: ProviderModelRoute): string {
  return findModel(route)?.id ?? route.model;
}

export function effortLevelsForModel(route: ProviderModelRoute): EffortLevel[] {
  return (
    findModel(route)?.efforts ?? getProviderConfig(route.provider)?.fallbackEfforts?.levels ?? []
  );
}

export function defaultEffortForModel(route: ProviderModelRoute): EffortLevel | null {
  // A cataloged model owns its default outright: an explicit null means the
  // route is effort-less, not that the provider fallback should answer.
  const found = findModel(route);
  if (found !== undefined) return found.defaultEffort;
  return getProviderConfig(route.provider)?.fallbackEfforts?.default ?? null;
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
  return modelsForProvider(provider)[0]?.id ?? "claude-opus-5";
}

export interface InitialModelInputs {
  provider: ProviderId;
  savedDefaultProvider: ProviderId;
  savedDefaultModel: string;
}

export function pickInitialModel(inputs: InitialModelInputs): string {
  const { provider, savedDefaultProvider, savedDefaultModel } = inputs;
  if (provider === savedDefaultProvider && savedDefaultModel) {
    const saved = findModel({ provider, model: savedDefaultModel });
    if (saved && saved.provider === provider) return saved.id;
  }
  return defaultModelForProvider(provider);
}

export function modelDisplayWithContext(route: ProviderModelRoute): string {
  const model = findModel(route);
  if (!model) return route.model;
  const suffix = parseModelId(route.model).is1m ? "1M" : compactContext(model.contextWindow);
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
