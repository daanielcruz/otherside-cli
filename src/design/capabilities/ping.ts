import { success } from "@/design/bridge/envelope.ts";
import type { DesignCapability } from "@/design/types.ts";

export const PingCapability: DesignCapability = {
  name: "ping",
  rpcMethod: {
    method: "ping",
    handler: (_params, ctx, id) => {
      ctx.send(success(id, { alive: true, port: ctx.port, version: ctx.version }));
    },
  },
};
