import { describe, expect, test } from "bun:test";
import { invoke, type MethodTable } from "@/design/bridge/dispatch.ts";
import { RPC_INTERNAL_ERROR } from "@/design/bridge/envelope.ts";
import type { JsonRpcResponse, RpcContext, RpcMethod } from "@/design/types.ts";

function tableWith(method: string, handler: RpcMethod): MethodTable {
  return {
    has: (candidate) => candidate === method,
    get: (candidate) => (candidate === method ? handler : undefined),
    names: () => [method],
  };
}

describe("design RPC dispatch", () => {
  test("does not expose handler errors to the peer", async () => {
    const sensitivePath = "/Users/alice/.otherside/private/snapshot.json";
    const sent: JsonRpcResponse[] = [];
    const context = {
      send: (frame: JsonRpcResponse) => sent.push(frame),
    } as unknown as RpcContext;

    await invoke(
      tableWith("design.fail", () => {
        throw new Error(sensitivePath);
      }),
      "design.fail",
      {},
      context,
      7,
    );

    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        error: { code: RPC_INTERNAL_ERROR, message: "internal error" },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain(sensitivePath);
  });
});
