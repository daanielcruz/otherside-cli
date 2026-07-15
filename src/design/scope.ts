import { isValidDesignId } from "@/design/storage.ts";
import type { RpcContext } from "@/design/types.ts";

export function activateDesignScope(ctx: RpcContext, designId: string): boolean {
  if (!isValidDesignId(designId)) return false;
  ctx.activeDesignId = designId;
  return true;
}

export function isActiveDesignScope(ctx: RpcContext, designId: string): boolean {
  return isValidDesignId(designId) && ctx.activeDesignId === designId;
}
