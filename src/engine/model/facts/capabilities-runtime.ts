import {
  canAutoRoute,
  isVisionCapable,
  visionParserModel,
} from "@/engine/model/facts/capabilities.ts";
import * as registry from "@/engine/providers/registry.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

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

export function resolveParserModel(provider: ProviderId): string {
  const model = visionParserModel(provider);
  if (model !== undefined) {
    return model;
  }
  try {
    return registry.get(provider).defaultModelId();
  } catch {
    return "";
  }
}

export function autoRoutesNonVision(provider: ProviderId): boolean {
  return canAutoRoute(provider);
}

export function visionCapableProviderIds(): ProviderId[] {
  return registry.listIds().filter((id) => canSendNatively(id));
}
