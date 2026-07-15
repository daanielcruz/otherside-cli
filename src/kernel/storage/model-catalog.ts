import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";

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
  findCatalogModel(id: string, provider?: ProviderId): CatalogModel | undefined;
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

export function findCatalogModel(id: string, provider?: ProviderId): CatalogModel | undefined {
  return requireModelCatalogProvider().findCatalogModel(id, provider);
}

export function catalogProviderConfig(provider: ProviderId): CatalogProviderConfig | undefined {
  return requireModelCatalogProvider().catalogProviderConfig(provider);
}

export function _resetModelCatalogProviderForTests(): void {
  provider = null;
}
