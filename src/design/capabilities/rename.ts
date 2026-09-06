import { fail, notify, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import { isValidDesignId, loadDesignSnapshot, saveDesignSnapshot } from "@/design/storage.ts";
import type { DesignCapability, DesignSnapshot, JsonRpcId, RpcContext } from "@/design/types.ts";

interface RenameInput {
  designId: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(params: unknown, fallbackDesignId: string): RenameInput | string {
  if (!isRecord(params)) return "params must be an object";
  if (typeof params.title !== "string" || params.title.trim().length === 0) {
    return "title must be a non-empty string";
  }
  const designId =
    typeof params.designId === "string" && params.designId.length > 0
      ? params.designId
      : fallbackDesignId;
  if (!isValidDesignId(designId)) return "designId contains unsafe characters";
  return { designId, title: params.title.trim() };
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parse(params, ctx.activeDesignId ?? "");
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  if (!isActiveDesignScope(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }
  const existing =
    ctx.snapshots.get(parsed.designId) ?? loadDesignSnapshot(ctx.cwd, parsed.designId);
  if (!existing) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "unknown designId"));
    return;
  }
  const next: DesignSnapshot = {
    ...existing,
    title: parsed.title,
    // An explicit rename is user-authored — clear any auto-generated marker.
    titleIsAuto: false,
    updatedAt: new Date().toISOString(),
  };
  ctx.snapshots.set(parsed.designId, next);
  saveDesignSnapshot(ctx.cwd, next);
  ctx.emit(notify("$/project-mutated", { title: parsed.title, isAutoTitle: false }));
  ctx.send(success(id, { renamed: true, designId: parsed.designId, title: parsed.title }));
}

export const DesignRenameCapability: DesignCapability = {
  name: "design.rename",
  rpcMethod: { method: "design.rename", handler: handle },
};
