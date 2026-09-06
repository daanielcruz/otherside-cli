import type { Device } from "@/backend/shared/device.ts";
import { appPermissionMode } from "@/backend/shared/permission-mode.ts";
import { isProviderId, type ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";
import {
  type CredentialsBundle,
  hasConfiguredCredential,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import {
  catalogModels,
  catalogProviderConfig,
  findCatalogModel,
} from "@/kernel/storage/model-catalog.ts";

// Exhaustive over ProviderId so adding a provider without a credential slug
// is a compile error instead of the provider silently missing from the app.
const CATALOG_PROVIDER_SLUGS: Record<ProviderId, ProviderSlug> = {
  anthropic: "anthropic",
  antigravity: "antigravity",
  codex: "codex",
  deepseek: "deepseek",
  xai: "xai",
  kimi: "kimi",
  minimax: "minimax",
  glm: "glm",
  openai: "openai",
};

function providerSlugForCatalog(providerId: string): ProviderSlug | null {
  if (!isProviderId(providerId)) return null;
  return CATALOG_PROVIDER_SLUGS[providerId];
}

export function compileAvailableModels(credentials: CredentialsBundle): Array<{
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}> {
  const catalog = catalogModels();
  const providers = new Map<
    string,
    { id: string; name: string; models: Array<{ id: string; name: string }> }
  >();
  for (const m of catalog) {
    const slug = providerSlugForCatalog(m.provider);
    if (!slug || !hasConfiguredCredential(credentials, slug)) continue;
    const config = catalogProviderConfig(m.provider);
    const gate = config?.modelAvailable ?? (() => true);
    if (!gate(m.id)) continue;
    let providerSnapshot = providers.get(m.provider);
    if (!providerSnapshot) {
      providerSnapshot = {
        id: m.provider,
        name: config?.provider?.label ?? m.provider,
        models: [],
      };
      providers.set(m.provider, providerSnapshot);
    }
    providerSnapshot.models.push({ id: m.id, name: m.displayName });
  }
  return Array.from(providers.values());
}

export type AvailableModelsProviders = ReturnType<typeof compileAvailableModels>;

export function sessionLivePayload(args: {
  device: Device;
  session: Session;
  broker: Broker;
  sessionSyncStatus: string;
}): {
  id: string;
  environment_id: string;
  provider: string;
  model: string;
  permission_mode: string;
  status: string;
  project: string;
  branch: string | null;
  updated_at: string;
} {
  const { device, session, broker, sessionSyncStatus } = args;
  const brokerState = broker.read();
  const modelEntry = findCatalogModel({ provider: brokerState.provider, model: brokerState.model });
  return {
    id: session.id,
    environment_id: device.id,
    provider: brokerState.provider,
    model: modelEntry?.displayName ?? brokerState.model,
    permission_mode: appPermissionMode(brokerState.permissionMode),
    status: sessionSyncStatus,
    project: session.cwd,
    branch: session.gitBranch || null,
    updated_at: new Date().toISOString(),
  };
}
