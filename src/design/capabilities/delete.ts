import { rmSync } from "node:fs";
import { fail, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import { designStorageDir, isValidDesignId } from "@/design/storage.ts";
import type { DesignCapability, JsonRpcId, RpcContext } from "@/design/types.ts";

interface DesignDeleteInput {
  designId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(params: unknown): DesignDeleteInput | string {
  if (!isRecord(params)) return "params must be an object";
  if (typeof params.designId !== "string" || params.designId.length === 0) {
    return "designId must be a non-empty string";
  }
  if (!isValidDesignId(params.designId)) return "designId contains unsafe characters";
  return { designId: params.designId };
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parse(params);
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  if (!isActiveDesignScope(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }
  ctx.snapshots.delete(parsed.designId);
  rmSync(designStorageDir(ctx.cwd, parsed.designId), { recursive: true, force: true });
  ctx.activeDesignId = null;
  ctx.send(success(id, { ok: true }));
}

export const DesignDeleteCapability: DesignCapability = {
  name: "design.delete",
  rpcMethod: { method: "design.delete", handler: handle },
};
