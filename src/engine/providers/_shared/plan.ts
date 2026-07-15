import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { loadFor, saveFor } from "@/kernel/storage/credentials.ts";

const PLAN_PROVIDERS = ["glm", "minimax"] as const;
type PlanProvider = (typeof PLAN_PROVIDERS)[number];
const PLAN_PROVIDER_SET: ReadonlySet<string> = new Set(PLAN_PROVIDERS);

function isPlanProvider(provider: ProviderId): provider is PlanProvider {
  return PLAN_PROVIDER_SET.has(provider);
}

export async function currentProviderPlan(provider: ProviderId): Promise<string | null> {
  if (!isPlanProvider(provider)) return null;
  const creds = await loadFor(provider);
  return creds?.plan ?? null;
}

export async function saveProviderPlan(provider: ProviderId, level: string | null): Promise<void> {
  if (!level || !isPlanProvider(provider)) return;
  if (provider === "glm") {
    const creds = await loadFor("glm");
    if (!creds?.zcodeJwtToken || creds.plan === level) return;
    await saveFor("glm", { ...creds, plan: level });
    return;
  }
  const creds = await loadFor("minimax");
  if (!creds?.apiKey || creds.plan === level) return;
  await saveFor("minimax", { ...creds, plan: level });
}
