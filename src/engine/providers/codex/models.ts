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
    defaultEffort: "high",
    augment: {
      useResponsesLite: true,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
  {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    contextWindow: 872_000,
    autoCompactTokenLimit: 784_800,
    provider: "codex",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    augment: {
      useResponsesLite: true,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
  {
    id: "gpt-daybreak-blue-latest",
    displayName: "GPT Daybreak Blue",
    contextWindow: 372_000,
    autoCompactTokenLimit: 334_800,
    provider: "codex",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
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
    defaultEffort: "high",
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
    defaultEffort: "high",
    augment: {
      useResponsesLite: true,
      serviceTiers: ["priority"],
      defaultVerbosity: "low",
    },
  },
];
