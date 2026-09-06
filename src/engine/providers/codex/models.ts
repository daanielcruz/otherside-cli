import type { CatalogModel } from "@/engine/model/catalog.ts";

export type CodexModelAugment = {
  useResponsesLite?: boolean;
  serviceTiers?: string[];
  defaultVerbosity?: "low" | "medium" | "high";
};

export const MODELS: readonly CatalogModel<CodexModelAugment>[] = [
  {
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    contextWindow: 872_000,
    autoCompactTokenLimit: 784_800,
    provider: "codex",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    augment: {
      useResponsesLite: true,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    contextWindow: 372_000,
    autoCompactTokenLimit: 334_800,
    provider: "codex",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    augment: {
      useResponsesLite: true,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    contextWindow: 372_000,
    autoCompactTokenLimit: 334_800,
    provider: "codex",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    augment: {
      useResponsesLite: true,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
  {
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    contextWindow: 372_000,
    autoCompactTokenLimit: 334_800,
    provider: "codex",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    augment: {
      useResponsesLite: true,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    contextWindow: 300_000,
    autoCompactTokenLimit: 280_000,
    provider: "codex",
    supportsPdf: true,
    onDemand: true,
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    augment: {
      useResponsesLite: false,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    contextWindow: 272_000,
    autoCompactTokenLimit: 244_800,
    provider: "codex",
    supportsPdf: true,
    onDemand: true,
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    augment: {
      useResponsesLite: false,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    contextWindow: 272_000,
    autoCompactTokenLimit: 244_800,
    provider: "codex",
    supportsPdf: true,
    onDemand: true,
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    augment: {
      useResponsesLite: false,
      serviceTiers: [],
      defaultVerbosity: "medium",
    },
  },
  {
    id: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    contextWindow: 128_000,
    autoCompactTokenLimit: 108_000,
    provider: "codex",
    supportsPdf: true,
    onDemand: true,
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    augment: {
      useResponsesLite: false,
      serviceTiers: [],
      defaultVerbosity: "low",
    },
  },
];
