import type { RequestContext } from "@/kernel/std/types/request.ts";

const GLM_MAX_OUTPUT_TOKENS = 64_000;
const GLM_THINKING_BUDGET_TOKENS = 32_000;
const GLM_TURBO_THINKING_BUDGET_TOKENS = 1024;

export function wireModelId(modelBase: string): string {
  if (modelBase === "glm-5-turbo") return "GLM-5-Turbo";
  return modelBase.replace(/^glm/, "GLM");
}

function thinkingBudgetTokens(modelBase: string): number {
  if (modelBase === "glm-5-turbo") return GLM_TURBO_THINKING_BUDGET_TOKENS;
  return GLM_THINKING_BUDGET_TOKENS;
}

function supportsEffort(modelBase: string): boolean {
  return modelBase !== "glm-5-turbo";
}

export interface GlmEnvelopeDeps {
  ctx: RequestContext;
  modelBase: string;
  wireSystem: unknown;
  wireMessages: unknown;
  tools: unknown[];
}

export function buildGlmEnvelope(deps: GlmEnvelopeDeps): Record<string, unknown> {
  const { ctx, modelBase, wireSystem, wireMessages, tools } = deps;
  const body: Record<string, unknown> = {
    model: wireModelId(modelBase),
    max_tokens: GLM_MAX_OUTPUT_TOKENS,
  };
  if (ctx.disableThinking === true) body.thinking = { type: "disabled" };
  else body.thinking = { type: "enabled", budget_tokens: thinkingBudgetTokens(modelBase) };
  if (ctx.disableThinking !== true && supportsEffort(modelBase)) {
    body.output_config = { effort: ctx.effort ?? "max" };
  }
  if (wireSystem) body.system = wireSystem;
  body.messages = wireMessages;
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }
  body.stream = true;
  return body;
}
