import { buildProvider } from "@/engine/contract/build.ts";
import { getProviderConfig, listProviderConfigs } from "@/engine/contract/registry.ts";
import type { Provider } from "@/engine/contract/types.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

const fakes = new Map<ProviderId, Provider>();

export function register(provider: Provider): void {
  fakes.set(provider.id, provider);
}

export function get(id: ProviderId): Provider {
  const fake = fakes.get(id);
  if (fake) return fake;
  const config = getProviderConfig(id);
  if (!config) throw new Error(`provider not registered: ${id}`);
  return buildProvider(config);
}

export function listIds(): ProviderId[] {
  const fromConfig = listProviderConfigs().map((c) => c.provider.id);
  const fromFakes = [...fakes.keys()].filter((id) => !fromConfig.includes(id));
  return [...fromConfig, ...fromFakes];
}

export function list(): Provider[] {
  return listIds().map(get);
}
