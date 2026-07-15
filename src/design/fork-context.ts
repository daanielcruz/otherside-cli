import type { DesignSnapshot, JsonRpcNotification } from "@/design/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface DesignForkContext {
  designId: string;
  cwd: string;
  snapshots: Map<string, DesignSnapshot>;
  emit: (notification: JsonRpcNotification) => void;
}

const contexts = new Map<string, DesignForkContext>();

export function registerDesignFork(forkId: string, context: DesignForkContext): void {
  contexts.set(forkId, context);
}

export function unregisterDesignFork(forkId: string): void {
  contexts.delete(forkId);
}

export function designForkContextFor(ctx: RequestContext): DesignForkContext | null {
  if (!ctx.agentOwnerId) return null;
  return contexts.get(ctx.agentOwnerId) ?? null;
}
