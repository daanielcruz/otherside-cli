import { fail, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import { isValidDesignId, loadDesignSnapshot, saveDesignSnapshot } from "@/design/storage.ts";
import type { DesignCapability, JsonRpcId, RpcContext } from "@/design/types.ts";

function persistModel(
  ctx: RpcContext,
  designId: string,
  provider: string | undefined,
  model: string | undefined,
  effort: string | null,
): void {
  const snapshot = ctx.snapshots.get(designId) ?? loadDesignSnapshot(ctx.cwd, designId);
  if (!snapshot) return;
  const next = {
    ...snapshot,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    effort,
    updatedAt: new Date().toISOString(),
  };
  ctx.snapshots.set(designId, next);
  saveDesignSnapshot(ctx.cwd, next);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  if (!isRecord(params)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "params must be an object"));
    return;
  }
  const providerId = typeof params.providerId === "string" ? params.providerId : undefined;
  const modelId = typeof params.modelId === "string" ? params.modelId : undefined;
  const effort = typeof params.effort === "string" ? params.effort : null;
  const designId =
    typeof params.designId === "string" ? params.designId : (ctx.activeDesignId ?? "");
  if (!isValidDesignId(designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId contains unsafe characters"));
    return;
  }
  if (!isActiveDesignScope(ctx, designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }

  persistModel(ctx, designId, providerId, modelId, effort);
  ctx.send(success(id, { ok: true }));
}

export const ModelSetCapability: DesignCapability = {
  name: "model.set",
  rpcMethod: {
    method: "model.set",
    handler: handle,
  },
};
