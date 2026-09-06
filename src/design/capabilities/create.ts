import { fail, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { activateDesignScope } from "@/design/scope.ts";
import { createDesignSnapshot } from "@/design/snapshot.ts";
import { isValidDesignId, loadDesignSnapshot, saveDesignSnapshot } from "@/design/storage.ts";
import type { DesignCapability, DesignSnapshot, JsonRpcId, RpcContext } from "@/design/types.ts";
import { uuidv4 } from "@/kernel/std/id.ts";

interface DesignCreateInput {
  designId: string;
  title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(params: unknown): DesignCreateInput | string {
  if (params === undefined || params === null) return { designId: uuidv4() };
  if (!isRecord(params)) return "params must be an object";
  if (params.designId !== undefined && typeof params.designId !== "string") {
    return "designId must be a string";
  }
  if (params.title !== undefined && typeof params.title !== "string") {
    return "title must be a string";
  }
  const designId =
    typeof params.designId === "string" && params.designId.length > 0 ? params.designId : uuidv4();
  if (!isValidDesignId(designId)) return "designId contains unsafe characters";
  const title = typeof params.title === "string" ? params.title.trim() : "";
  return { designId, ...(title.length > 0 ? { title } : {}) };
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parse(params);
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  const existing =
    ctx.snapshots.get(parsed.designId) ?? loadDesignSnapshot(ctx.cwd, parsed.designId);
  if (existing) {
    ctx.snapshots.set(parsed.designId, existing);
    activateDesignScope(ctx, parsed.designId);
    ctx.send(success(id, { designId: parsed.designId }));
    return;
  }
  const base = createDesignSnapshot({ designId: parsed.designId });
  const snapshot: DesignSnapshot = parsed.title ? { ...base, title: parsed.title } : base;
  ctx.snapshots.set(parsed.designId, snapshot);
  saveDesignSnapshot(ctx.cwd, snapshot);
  activateDesignScope(ctx, parsed.designId);
  ctx.send(success(id, { designId: parsed.designId }));
}

export const DesignCreateCapability: DesignCapability = {
  name: "design.create",
  rpcMethod: { method: "design.create", handler: handle },
};
