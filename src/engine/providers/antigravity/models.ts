export interface AntigravityModelSpec {
  wireModel: string;
  maxOutputTokens: number;
  thinkingBudget: number;
  modelEnum: string;
  usedClaude: boolean;
}

export const DEFAULT_MODEL_ID = "gemini-3-flash";

const FLASH_HIGH: AntigravityModelSpec = {
  wireModel: "gemini-3-flash-agent",
  maxOutputTokens: 65536,
  thinkingBudget: 10000,
  modelEnum: "MODEL_PLACEHOLDER_M84",
  usedClaude: false,
};

const SPECS: Record<string, AntigravityModelSpec> = {
  "gemini-3-flash": FLASH_HIGH,
  "gemini-3-flash-medium": {
    wireModel: "gemini-3.5-flash-low",
    maxOutputTokens: 65536,
    thinkingBudget: 4000,
    modelEnum: "MODEL_PLACEHOLDER_M20",
    usedClaude: false,
  },
  "gemini-3-flash-low": {
    wireModel: "gemini-3.5-flash-extra-low",
    maxOutputTokens: 65536,
    thinkingBudget: 1000,
    modelEnum: "MODEL_PLACEHOLDER_M187",
    usedClaude: false,
  },
  "gemini-3.1-pro-high": {
    wireModel: "gemini-pro-agent",
    maxOutputTokens: 65535,
    thinkingBudget: 10001,
    modelEnum: "MODEL_PLACEHOLDER_M16",
    usedClaude: false,
  },
  "gemini-3.1-pro-low": {
    wireModel: "gemini-3.1-pro-low",
    maxOutputTokens: 65535,
    thinkingBudget: 1001,
    modelEnum: "MODEL_PLACEHOLDER_M36",
    usedClaude: false,
  },
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

export function resolveAntigravityModel(modelId: string): AntigravityModelSpec {
  const spec = SPECS[modelId];
  if (spec) return spec;
  return { ...FLASH_HIGH, wireModel: modelId };
}
