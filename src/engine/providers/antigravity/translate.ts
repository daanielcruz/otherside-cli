import { canSendPdfNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import {
  buildGeminiRequest,
  encodeGeminiToolName,
  geminiSanitizeSchema,
  translateGeminiResponse,
} from "@/engine/providers/_shared/gemini-wire.ts";
import { readRawToolDecl } from "@/engine/providers/_shared/tool-decl.ts";
import {
  type AntigravityModelSpec,
  resolveAntigravityModel,
} from "@/engine/providers/antigravity/models.ts";
import {
  lastExecutionId,
  trajectoryStepCount,
  turnIds,
} from "@/engine/providers/antigravity/turn.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const FUNCTION_CALLING_MODE = "VALIDATED";

export interface AntigravityBodyExtras {
  sessionContext?: string | undefined;
}

function buildLabels(
  spec: AntigravityModelSpec,
  trajectoryId: string,
  stepIndex: number,
  lastExecution?: string,
): Record<string, string> {
  const usedClaude = spec.usedClaude ? "true" : "false";
  // Every non-gemini family (claude, gpt-oss) trips this; gemini models don't.
  const usedNonGemini = spec.wireModel.startsWith("gemini") ? "false" : "true";
  return {
    ...(lastExecution ? { last_execution_id: lastExecution } : {}),
    last_step_index: String(stepIndex),
    model_enum: spec.modelEnum,
    trajectory_id: trajectoryId,
    used_claude: usedClaude,
    used_claude_conservative: usedClaude,
    used_non_gemini_model: usedNonGemini,
  };
}

function buildGenerationConfig(
  ctx: RequestContext,
  spec: AntigravityModelSpec,
): Record<string, unknown> {
  return {
    maxOutputTokens: spec.maxOutputTokens,
    thinkingConfig: {
      includeThoughts: ctx.disableThinking !== true && ctx.suppressThinkingSummary !== true,
      thinkingBudget: spec.thinkingBudget,
    },
  };
}

/**
 * Recursively walks the schema and normalizes anyOf/oneOf combinators.
 * The provider schema converter rejects anyOf/oneOf for anthropic models,
 * so we flatten these into a simpler representation for Claude models.
 */
export function flattenChoiceCombinators(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return node;
  }
  const obj = { ...(node as Record<string, unknown>) };

  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    const properties = { ...(obj.properties as Record<string, unknown>) };
    for (const [k, v] of Object.entries(properties)) {
      properties[k] = flattenChoiceCombinators(v);
    }
    obj.properties = properties;
  }

  if (obj.items !== undefined) {
    obj.items = Array.isArray(obj.items)
      ? obj.items.map(flattenChoiceCombinators)
      : flattenChoiceCombinators(obj.items);
  }

  if (Array.isArray(obj.allOf)) {
    obj.allOf = obj.allOf.map(flattenChoiceCombinators);
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(obj[key])) {
      const branches = (obj[key] as unknown[]).map(flattenChoiceCombinators);
      delete obj[key];

      if (branches.length > 0) {
        let commonType: string | null = null;
        let canMerge = true;
        const enumValues: unknown[] = [];
        let hasMissingEnum = false;

        for (const branch of branches) {
          if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
            canMerge = false;
            break;
          }
          const bObj = branch as Record<string, unknown>;
          const bType = bObj.type;
          if (typeof bType !== "string") {
            canMerge = false;
            break;
          }

          if (commonType === null) {
            commonType = bType;
          } else if (commonType !== bType) {
            canMerge = false;
            break;
          }

          if (Array.isArray(bObj.enum)) {
            enumValues.push(...bObj.enum);
          } else {
            hasMissingEnum = true;
          }
        }

        if (canMerge && commonType !== null) {
          obj.type = commonType;
          if (!hasMissingEnum) {
            obj.enum = Array.from(new Set(enumValues));
          } else {
            delete obj.enum;
          }
        } else {
          // If mixed/unmergeable, we already deleted obj[key].
          // Keep other keys.
        }
      }
    }
  }

  return obj;
}

// agy emits every function as its OWN `{ functionDeclarations: [ <1 fn> ] }` entry
// (not one array of N), each decl keyed name -> description -> parameters. This is
// the antigravity-specific tool shape — the shared Gemini builder packs all decls
// into a single entry in name -> parameters -> description order, which the vanilla
// Gemini path keeps. Verified against the agy 1.0.16 wire.
function buildAntigravityToolEntries(
  tools: unknown[],
  spec: AntigravityModelSpec,
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    const fields = readRawToolDecl(tool);
    if (!fields) continue;
    const decl: Record<string, unknown> = { name: encodeGeminiToolName(fields.name) };
    if (fields.description !== undefined) decl.description = fields.description;
    let parameters = geminiSanitizeSchema(fields.parameters);
    if (spec.usedClaude) {
      parameters = flattenChoiceCombinators(parameters);
    }
    decl.parameters = parameters;
    entries.push({ functionDeclarations: [decl] });
  }
  return entries;
}

export function translateRequestAntigravity(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
  extras: AntigravityBodyExtras = {},
): unknown {
  const spec = resolveAntigravityModel(ctx.model);
  const ids = turnIds(ctx.sessionId, ctx.agentOwnerId);
  const built = buildGeminiRequest({
    ctx,
    messages,
    tools: [], // antigravity builds its own per-function tool entries below
    thinkingConfig: null,
    sessionContext: extras.sessionContext,
    framing: {
      replayThinking: true,
      wrapToolOutput: true,
      alwaysSignFunctionCall: true,
      targetUsedClaude: spec.usedClaude,
      supportsPdf: canSendPdfNatively(ctx.provider, ctx.model),
    },
  });
  const base = built.body;

  const request: Record<string, unknown> = { contents: base.contents };
  if (built.systemText.length > 0) {
    request.systemInstruction = { role: "user", parts: [{ text: built.systemText }] };
  }
  const toolEntries = buildAntigravityToolEntries(tools, spec);
  if (toolEntries.length > 0) request.tools = toolEntries;
  request.toolConfig = { functionCallingConfig: { mode: FUNCTION_CALLING_MODE } };
  request.labels = buildLabels(
    spec,
    ids.trajectoryId,
    trajectoryStepCount(request),
    lastExecutionId(ctx.sessionId, ctx.agentOwnerId, request),
  );
  request.generationConfig = buildGenerationConfig(ctx, spec);
  request.sessionId = ids.sessionId;
  return request;
}

export function translateResponseAntigravity(
  raw: AsyncIterable<Uint8Array>,
): AsyncIterable<ProviderEvent> {
  return translateGeminiResponse(raw, {
    onRateLimit(body) {
      throw new ProviderHttpError({
        provider: "antigravity",
        status: 429,
        body,
        retryAfterHeader: null,
      });
    },
    onHttpError(code, body) {
      throw new ProviderHttpError({ provider: "antigravity", status: code, body });
    },
  });
}
