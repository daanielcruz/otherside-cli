import { fail, RPC_INTERNAL_ERROR, RPC_METHOD_NOT_FOUND } from "@/design/bridge/envelope.ts";
import type { DesignCapability, JsonRpcId, RpcContext, RpcMethod } from "@/design/types.ts";
import { writeDebugError } from "@/devtools/output.ts";

export interface MethodTable {
  has(method: string): boolean;
  get(method: string): RpcMethod | undefined;
  names(): string[];
}

export function buildMethodTable(capabilities: readonly DesignCapability[]): MethodTable {
  const map = new Map<string, RpcMethod>();
  for (const capability of capabilities) {
    if (!capability.rpcMethod) continue;
    if (map.has(capability.rpcMethod.method)) {
      throw new Error(`design: duplicate rpc method ${capability.rpcMethod.method}`);
    }
    map.set(capability.rpcMethod.method, capability.rpcMethod.handler);
  }
  return {
    has: (method) => map.has(method),
    get: (method) => map.get(method),
    names: () => Array.from(map.keys()),
  };
}

export async function invoke(
  table: MethodTable,
  method: string,
  params: unknown,
  ctx: RpcContext,
  id: JsonRpcId,
): Promise<void> {
  const handler = table.get(method);
  if (!handler) {
    ctx.send(fail(id, RPC_METHOD_NOT_FOUND, `method not found: ${method}`));
    return;
  }
  try {
    await handler(params, ctx, id);
  } catch (error) {
    writeDebugError("design rpc handler failed", method, error);
    ctx.send(fail(id, RPC_INTERNAL_ERROR, "internal error"));
  }
}
