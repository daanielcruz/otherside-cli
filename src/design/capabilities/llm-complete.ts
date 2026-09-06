import { fail, RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import { isValidDesignId } from "@/design/storage.ts";
import type { DesignCapability, JsonRpcId, RpcContext } from "@/design/types.ts";
import { writeDebugError } from "@/devtools/output.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { executeOneShotCompletion } from "./llm-stream.ts";

interface CompleteInput {
  prompt: string;
  requestId: string;
  designId?: string;
  maxTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(params: unknown): CompleteInput | string {
  if (!isRecord(params)) return "params must be an object";
  const prompt = params.prompt;
  const requestId = params.requestId;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return "prompt must be a non-empty string";
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    return "requestId must be a non-empty string";
  }
  const designId = typeof params.designId === "string" ? params.designId : undefined;
  if (designId !== undefined && !isValidDesignId(designId)) {
    return "designId contains unsafe characters";
  }
  const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : undefined;

  return {
    prompt,
    requestId,
    ...(designId !== undefined ? { designId } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

async function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): Promise<void> {
  const parsed = parse(params);
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }

  const designId = parsed.designId ?? ctx.activeDesignId ?? "";
  if (!isActiveDesignScope(ctx, designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }
  const snapshot = ctx.snapshots.get(designId);
  const broker = ctx.broker.read();
  const targetProvider = (
    snapshot && snapshot.provider !== undefined ? snapshot.provider : broker.provider
  ) as ProviderId;
  const targetModel = snapshot && snapshot.model !== undefined ? snapshot.model : broker.model;

  const requestContext = makeRequestContext(ctx.agent.deps);
  requestContext.cwd = ctx.cwd;
  requestContext.sessionId = ctx.session.id;
  requestContext.permissionMode = "default";
  requestContext.permissionModeIsFixed = true;
  requestContext.provider = targetProvider;
  requestContext.model = targetModel;
  requestContext.effort = null;

  const systemPrompt =
    "You are an assistant embedded in a design prototype. Respond directly and concisely, without any decorative markdown, formatting, or conversational filler.";

  const rawMaxTokens = parsed.maxTokens ?? 512;
  const clampedMaxTokens = Math.max(1, Math.min(rawMaxTokens, 2048));

  try {
    const text = await executeOneShotCompletion(
      requestContext,
      systemPrompt,
      parsed.prompt,
      clampedMaxTokens,
      0.7,
    );
    ctx.send(success(id, { requestId: parsed.requestId, text }));
  } catch (error) {
    writeDebugError("design completion failed", error);
    ctx.send(fail(id, RPC_INTERNAL_ERROR, "completion failed"));
  }
}

export const LlmCompleteCapability: DesignCapability = {
  name: "llm.complete",
  rpcMethod: {
    method: "llm.complete",
    handler: handle,
  },
};
