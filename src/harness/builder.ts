import type {
  ComposedHarness,
  LayerContext,
  ResolvedHarnessFacts,
} from "@/harness/composer/injections.ts";
import { applyAdapter, type ProviderPromptAdapter } from "@/harness/composer/prompt-adapter.ts";
import { compose, defaultStack } from "@/harness/composer.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface BuildHarnessInput {
  ctx: RequestContext;
  facts: ResolvedHarnessFacts;
  promptAdapter?: ProviderPromptAdapter | null;
}

export function buildHarness(input: BuildHarnessInput): ComposedHarness {
  const ctx: LayerContext = { ...input.ctx, ...input.facts };
  return compose(applyAdapter(defaultStack(), input.promptAdapter), ctx);
}
