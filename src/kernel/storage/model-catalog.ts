import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export interface CatalogModel {
  id: string;
  displayName: string;
  contextWindow: number;
  provider: ProviderId;
  supports1m?: boolean;
  efforts: EffortLevel[];
  defaultEffort: EffortLevel | null;
  autoCompactTokenLimit?: number;
  augment?: unknown;
}

export interface CatalogProviderConfig {
  provider?: { label?: string };
  modelAvailable?: (model: string) => boolean;
}

export interface ModelCatalogProvider {
  catalogModels(): CatalogModel[];
  findCatalogModel(route: ProviderModelRoute): CatalogModel | undefined;
  catalogProviderConfig(provider: ProviderId): CatalogProviderConfig | undefined;
}

let provider: ModelCatalogProvider | null = null;

export function registerModelCatalogProvider(impl: ModelCatalogProvider): void {
  provider = impl;
}

function requireModelCatalogProvider(): ModelCatalogProvider {
  if (provider === null) {
    throw new Error("Model catalog provider is not registered");
  }
  return provider;
}

export function catalogModels(): CatalogModel[] {
  return requireModelCatalogProvider().catalogModels();
}

export function findCatalogModel(route: ProviderModelRoute): CatalogModel | undefined {
  return requireModelCatalogProvider().findCatalogModel(route);
}

export function catalogProviderConfig(provider: ProviderId): CatalogProviderConfig | undefined {
  return requireModelCatalogProvider().catalogProviderConfig(provider);
}

export function _resetModelCatalogProviderForTests(): void {
  provider = null;
}
