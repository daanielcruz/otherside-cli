import type { EffortLevel } from "@/kernel/std/types/effort.ts";

export interface AntigravityModelSpec {
  wireModel: string;
  maxOutputTokens: number;
  thinkingBudget: number;
  modelEnum: string;
  usedClaude: boolean;
}

// Spec values are copied verbatim from live fetchAvailableModels: catalog key →
// wireModel, entry `model` → modelEnum, thinkingBudget as listed (-1 = server-side
// dynamic thinking on High tiers). The catalog is filtered by the declared client
// version, so re-read it with the current version before adding a family.
const FLASH_38_HIGH: AntigravityModelSpec = {
  wireModel: "gemini-3.8-flash-high",
  maxOutputTokens: 65536,
  thinkingBudget: -1,
  modelEnum: "MODEL_PLACEHOLDER_M318",
  usedClaude: false,
};

const FLASH_38_MEDIUM: AntigravityModelSpec = {
  wireModel: "gemini-3.8-flash-medium",
  maxOutputTokens: 65536,
  thinkingBudget: 4000,
  modelEnum: "MODEL_PLACEHOLDER_M319",
  usedClaude: false,
};

const FLASH_38_LOW: AntigravityModelSpec = {
  wireModel: "gemini-3.8-flash-low",
  maxOutputTokens: 65536,
  thinkingBudget: 1000,
  modelEnum: "MODEL_PLACEHOLDER_M320",
  usedClaude: false,
};

const FLASH_37_HIGH: AntigravityModelSpec = {
  wireModel: "gemini-3.7-flash-high",
  maxOutputTokens: 65536,
  thinkingBudget: -1,
  modelEnum: "MODEL_PLACEHOLDER_M298",
  usedClaude: false,
};

const FLASH_37_MEDIUM: AntigravityModelSpec = {
  wireModel: "gemini-3.7-flash-medium",
  maxOutputTokens: 65536,
  thinkingBudget: 4000,
  modelEnum: "MODEL_PLACEHOLDER_M299",
  usedClaude: false,
};

const FLASH_37_LOW: AntigravityModelSpec = {
  wireModel: "gemini-3.7-flash-low",
  maxOutputTokens: 65536,
  thinkingBudget: 1000,
  modelEnum: "MODEL_PLACEHOLDER_M300",
  usedClaude: false,
};

const FLASH_HIGH: AntigravityModelSpec = {
  wireModel: "gemini-3-flash-agent",
  maxOutputTokens: 65536,
  thinkingBudget: 10000,
  modelEnum: "MODEL_PLACEHOLDER_M84",
  usedClaude: false,
};

const FLASH_36_HIGH: AntigravityModelSpec = {
  wireModel: "gemini-3.6-flash-high",
  maxOutputTokens: 65536,
  thinkingBudget: -1,
  modelEnum: "MODEL_PLACEHOLDER_M71",
  usedClaude: false,
};

const FLASH_36_MEDIUM: AntigravityModelSpec = {
  wireModel: "gemini-3.6-flash-medium",
  maxOutputTokens: 65536,
  thinkingBudget: 4000,
  modelEnum: "MODEL_PLACEHOLDER_M72",
  usedClaude: false,
};

const FLASH_36_LOW: AntigravityModelSpec = {
  wireModel: "gemini-3.6-flash-low",
  maxOutputTokens: 65536,
  thinkingBudget: 1000,
  modelEnum: "MODEL_PLACEHOLDER_M73",
  usedClaude: false,
};

const FLASH_35_MEDIUM: AntigravityModelSpec = {
  wireModel: "gemini-3.5-flash-low",
  maxOutputTokens: 65536,
  thinkingBudget: 4000,
  modelEnum: "MODEL_PLACEHOLDER_M20",
  usedClaude: false,
};

const FLASH_35_LOW: AntigravityModelSpec = {
  wireModel: "gemini-3.5-flash-extra-low",
  maxOutputTokens: 65536,
  thinkingBudget: 1000,
  modelEnum: "MODEL_PLACEHOLDER_M187",
  usedClaude: false,
};

const PRO_31_HIGH: AntigravityModelSpec = {
  wireModel: "gemini-pro-agent",
  maxOutputTokens: 65535,
  thinkingBudget: 10001,
  modelEnum: "MODEL_PLACEHOLDER_M16",
  usedClaude: false,
};

const PRO_31_LOW: AntigravityModelSpec = {
  wireModel: "gemini-3.1-pro-low",
  maxOutputTokens: 65535,
  thinkingBudget: 1001,
  modelEnum: "MODEL_PLACEHOLDER_M36",
  usedClaude: false,
};

const SPECS: Record<string, AntigravityModelSpec> = {
  "gemini-3.8-flash": FLASH_38_HIGH,
  "gemini-3.8-flash-high": FLASH_38_HIGH,
  "gemini-3.8-flash-medium": FLASH_38_MEDIUM,
  "gemini-3.8-flash-low": FLASH_38_LOW,
  "gemini-3.7-flash": FLASH_37_HIGH,
  "gemini-3.7-flash-high": FLASH_37_HIGH,
  "gemini-3.7-flash-medium": FLASH_37_MEDIUM,
  "gemini-3.7-flash-low": FLASH_37_LOW,
  "gemini-3.6-flash": FLASH_36_HIGH,
  "gemini-3.6-flash-high": FLASH_36_HIGH,
  "gemini-3.6-flash-medium": FLASH_36_MEDIUM,
  "gemini-3.6-flash-low": FLASH_36_LOW,
  "gemini-3-flash": FLASH_HIGH,
  "gemini-3.5-flash-high": FLASH_HIGH,
  "gemini-3-flash-medium": FLASH_35_MEDIUM,
  "gemini-3.5-flash-medium": FLASH_35_MEDIUM,
  "gemini-3-flash-low": FLASH_35_LOW,
  "gemini-3.5-flash-low": FLASH_35_LOW,
  "gemini-3.1-pro": PRO_31_HIGH,
  "gemini-3.1-pro-high": PRO_31_HIGH,
  "gemini-3.1-pro-low": PRO_31_LOW,
  "claude-sonnet-4-6": {
    wireModel: "claude-sonnet-4-6",
    maxOutputTokens: 64000,
    thinkingBudget: 1024,
    modelEnum: "MODEL_PLACEHOLDER_M35",
    usedClaude: true,
  },
  "claude-opus-4-6-thinking": {
    wireModel: "claude-opus-4-6-thinking",
    maxOutputTokens: 64000,
    thinkingBudget: 1024,
    modelEnum: "MODEL_PLACEHOLDER_M26",
    usedClaude: true,
  },
  "gpt-oss-120b-medium": {
    wireModel: "gpt-oss-120b-medium",
    maxOutputTokens: 32768,
    thinkingBudget: 8192,
    modelEnum: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
    usedClaude: false,
  },
};

export function resolveAntigravityModel(
  modelId: string,
  effort?: EffortLevel | null,
): AntigravityModelSpec {
  const eff = effort ?? "high";

  if (modelId === "gemini-3.8-flash") {
    if (eff === "low") return FLASH_38_LOW;
    if (eff === "medium") return FLASH_38_MEDIUM;
    return FLASH_38_HIGH;
  }

  if (modelId === "gemini-3.7-flash") {
    if (eff === "low") return FLASH_37_LOW;
    if (eff === "medium") return FLASH_37_MEDIUM;
    return FLASH_37_HIGH;
  }

  if (modelId === "gemini-3.6-flash") {
    if (eff === "low") return FLASH_36_LOW;
    if (eff === "medium") return FLASH_36_MEDIUM;
    return FLASH_36_HIGH;
  }

  if (modelId === "gemini-3-flash" || modelId === "gemini-3.5-flash") {
    if (eff === "low") return FLASH_35_LOW;
    if (eff === "medium") return FLASH_35_MEDIUM;
    return FLASH_HIGH;
  }

  if (modelId === "gemini-3.1-pro" || modelId === "gemini-pro") {
    if (eff === "low") return PRO_31_LOW;
    if (eff === "medium") return FLASH_36_HIGH;
    return PRO_31_HIGH;
  }

  const spec = SPECS[modelId];
  if (spec) return spec;
  return { ...FLASH_36_HIGH, wireModel: modelId };
}
