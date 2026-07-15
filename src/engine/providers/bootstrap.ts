import { registerProviderConfig } from "@/engine/contract/registry.ts";
import type { Provider, ProviderConfig } from "@/engine/contract/types.ts";
import { config as anthropicConfig } from "@/engine/providers/anthropic/config.ts";
import anthropic from "@/engine/providers/anthropic/index.ts";
import { config as antigravityConfig } from "@/engine/providers/antigravity/config.ts";
import antigravity from "@/engine/providers/antigravity/index.ts";
import { config as codexConfig } from "@/engine/providers/codex/config.ts";
import codex from "@/engine/providers/codex/index.ts";
import { config as deepseekConfig } from "@/engine/providers/deepseek/config.ts";
import deepseek from "@/engine/providers/deepseek/index.ts";
import { config as glmConfig } from "@/engine/providers/glm/config.ts";
import glm from "@/engine/providers/glm/index.ts";
import { config as kimiConfig } from "@/engine/providers/kimi/config.ts";
import kimi from "@/engine/providers/kimi/index.ts";
import { config as minimaxConfig } from "@/engine/providers/minimax/config.ts";
import minimax from "@/engine/providers/minimax/index.ts";
import { config as openaiConfig } from "@/engine/providers/openai/config.ts";
import openai from "@/engine/providers/openai/index.ts";
import * as providers from "@/engine/providers/registry.ts";
import { config as xaiConfig } from "@/engine/providers/xai/config.ts";
import xai from "@/engine/providers/xai/index.ts";
import type { Api } from "@/engine/translator/dispatch/types.ts";

interface ProviderDescriptor {
  plugin: Provider;
  config: ProviderConfig<Api>;
}

function descriptor<A extends Api>(
  plugin: Provider,
  config: ProviderConfig<A>,
): ProviderDescriptor {
  return { plugin, config: config as unknown as ProviderConfig<Api> };
}

export const PROVIDERS = [
  descriptor(anthropic, anthropicConfig),
  descriptor(kimi, kimiConfig),
  descriptor(deepseek, deepseekConfig),
  descriptor(minimax, minimaxConfig),
  descriptor(glm, glmConfig),
  descriptor(openai, openaiConfig),
  descriptor(codex, codexConfig),
  descriptor(xai, xaiConfig),
  descriptor(antigravity, antigravityConfig),
] as const;

export function registerAllProviders(): void {
  for (const provider of PROVIDERS) providers.register(provider.plugin);
}

export function bootstrapLlmApiRegistry(): void {
  for (const provider of PROVIDERS) registerProviderConfig(provider.config);
}
