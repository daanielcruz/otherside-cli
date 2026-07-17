import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
  currency: "USD";
}

type PricingTable = Partial<Record<ProviderId, (modelId: string) => ModelPricing | null>>;

const TABLE: PricingTable = {
  deepseek: (modelId) =>
    modelId.includes("reasoner") || modelId.includes("pro")
      ? { inputPerM: 0.55, outputPerM: 2.19, cachedInputPerM: 0.14, currency: "USD" }
      : { inputPerM: 0.14, outputPerM: 0.28, cachedInputPerM: 0.01, currency: "USD" },
  kimi: (modelId) =>
    modelId.includes("kimi")
      ? { inputPerM: 0, outputPerM: 0, cachedInputPerM: 0, currency: "USD" }
      : null,
  minimax: () => ({ inputPerM: 0.3, outputPerM: 1.2, cachedInputPerM: 0.03, currency: "USD" }),
  xai: (modelId) =>
    modelId.includes("fast") || modelId.includes("code")
      ? { inputPerM: 0.2, outputPerM: 0.5, cachedInputPerM: 0.05, currency: "USD" }
      : { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.75, currency: "USD" },
  glm: (modelId) => {
    if (modelId.includes("flash")) {
      return { inputPerM: 0, outputPerM: 0, cachedInputPerM: 0, currency: "USD" };
    }
    if (modelId.startsWith("glm-5")) {
      return { inputPerM: 1.4, outputPerM: 4.4, cachedInputPerM: 0.26, currency: "USD" };
    }
    if (modelId.includes("air")) {
      return { inputPerM: 0.2, outputPerM: 1.1, cachedInputPerM: 0.03, currency: "USD" };
    }
    return { inputPerM: 0.6, outputPerM: 2.2, cachedInputPerM: 0.11, currency: "USD" };
  },
  openai: () => ({
    inputPerM: 0,
    outputPerM: 0,
    cachedInputPerM: 0,
    currency: "USD",
  }),
};

export function pricingFor(providerId: ProviderId, modelId: string): ModelPricing | null {
  const fn = TABLE[providerId];
  if (!fn) return null;
  return fn(modelId);
}
