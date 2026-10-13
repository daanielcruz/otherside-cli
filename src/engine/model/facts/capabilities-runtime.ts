import { getProviderConfig } from "@/engine/contract/registry.ts";
import { availableModelsForProvider, findModel } from "@/engine/model/catalog.ts";
import {
  canAutoRoute,
  isVisionCapable,
  visionParserModel,
} from "@/engine/model/facts/capabilities.ts";
import * as registry from "@/engine/providers/registry.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export function canSendNatively(provider: ProviderId, model?: string): boolean {
  if (!isVisionCapable(provider, model)) {
    return false;
  }
  try {
    return registry.get(provider).featureFlags().supportsImages === true;
  } catch {
    return false;
  }
}

export function canSendPdfNatively(provider: ProviderId, model: string): boolean {
  const catalogModel = findModel({ provider, model });
  if (catalogModel) return catalogModel.supportsPdf === true;
  const models = getProviderConfig(provider)?.legacyModels;
  const entries = typeof models === "function" ? models() : (models ?? []);
  return entries.some((entry) => entry.id === model && entry.supportsPdf === true);
}

/** The model a provider parses images with: its default when that one reads images. */
export function resolveParserModel(provider: ProviderId): string {
  const model = visionParserModel(provider);
  if (model !== undefined) {
    return model;
  }
  let defaultModel: string;
  try {
    defaultModel = registry.get(provider).defaultModelId();
  } catch {
    return "";
  }
  if (isVisionCapable(provider, defaultModel)) return defaultModel;
  return parserModelsFor(provider)[0] ?? defaultModel;
}

/** The provider's models that can read an image handed to them. */
export function parserModelsFor(provider: ProviderId): string[] {
  return availableModelsForProvider(provider)
    .map((entry) => entry.id)
    .filter((id) => isVisionCapable(provider, id));
}

export function autoRoutesNonVision(provider: ProviderId): boolean {
  return canAutoRoute(provider);
}

export function visionCapableProviderIds(): ProviderId[] {
  return registry.listIds().filter((id) => canSendNatively(id));
}
