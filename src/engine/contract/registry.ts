import type { ProviderConfig } from "@/engine/contract/types.ts";
import type { Api } from "@/engine/translator/dispatch/types.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

const configs = new Map<ProviderId, ProviderConfig<Api>>();

export function registerProviderConfig<A extends Api>(config: ProviderConfig<A>): void {
  configs.set(config.provider.id, config as unknown as ProviderConfig<Api>);
}

export function getProviderConfig(id: ProviderId): ProviderConfig<Api> | undefined {
  return configs.get(id);
}

export function listProviderConfigs(): ProviderConfig<Api>[] {
  return [...configs.values()];
}

export function unregisterProviderConfig(id: ProviderId): boolean {
  return configs.delete(id);
}

export function clearProviderConfigs(): void {
  configs.clear();
}

export function providerSortRank(id: ProviderId): number {
  if (id === "openai") return 2;
  if (id === "deepseek" || id === "kimi" || id === "glm" || id === "minimax") return 1;
  return 0;
}
