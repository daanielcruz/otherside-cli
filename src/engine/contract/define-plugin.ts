import { buildProvider } from "@/engine/contract/build.ts";
import { registerProviderConfig } from "@/engine/contract/registry.ts";
import type { Provider, ProviderConfig } from "@/engine/contract/types.ts";
import type { Api } from "@/engine/translator/dispatch/types.ts";

export function definePlugin<A extends Api>(config: ProviderConfig<A>): Provider {
  registerProviderConfig(config);
  return buildProvider(config);
}
