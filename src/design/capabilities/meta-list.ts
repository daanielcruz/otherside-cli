import { success } from "@/design/bridge/envelope.ts";
import type { DesignCapability } from "@/design/types.ts";
import { listProviderConfigs } from "@/engine/contract/registry.ts";
import { availableModelsForProvider } from "@/engine/model/catalog.ts";

type ProviderConfigEntry = ReturnType<typeof listProviderConfigs>[number];

export async function providers(currentProviderId: string) {
  const configs = listProviderConfigs();
  const authed: ProviderConfigEntry[] = [];
  for (const config of configs) {
    let ok = true;
    if (config.auth) {
      try {
        ok = (await config.auth.load()) !== null;
      } catch {
        // A probe that throws is answered the same way as one that finds no
        // credential: the provider is reported unauthenticated in the response.
        ok = false;
      }
    }
    if (ok) authed.push(config);
  }

  let selected: ProviderConfigEntry[] = authed;
  if (authed.length === 0) {
    selected = [...configs];
  } else if (!authed.some((config) => config.provider.id === currentProviderId)) {
    const currentConfig = configs.find((config) => config.provider.id === currentProviderId);
    if (currentConfig) selected = [...authed, currentConfig];
  }

  return selected.map((config) => ({
    id: config.provider.id,
    name: config.provider.label,
    models: availableModelsForProvider(config.provider.id).map((model) => ({
      id: model.id,
      name: model.displayName,
      efforts: model.efforts,
      defaultEffort: model.defaultEffort,
      contextWindow: model.contextWindow,
    })),
  }));
}

export const MetaListCapability: DesignCapability = {
  name: "meta.list",
  rpcMethod: {
    method: "meta.list",
    handler: async (_params, ctx, id) => {
      const broker = ctx.broker.read();
      const snapshot = ctx.snapshots.get(ctx.designId);
      const provider = snapshot?.provider ?? broker.provider;
      const model = snapshot?.model ?? broker.model;
      const effort = snapshot?.effort !== undefined ? snapshot.effort : broker.effort;
      const list = await providers(provider);
      ctx.send(
        success(id, {
          methods: ctx.authorizedMethods(),
          providers: list,
          current: { provider, model, effort },
          designSystem: { designSystemId: "default", isDefault: true },
        }),
      );
    },
  },
};
