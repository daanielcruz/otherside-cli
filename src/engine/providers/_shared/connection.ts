import type { RequestContext } from "@/kernel/std/types/request.ts";

// After a stream idle timeout the retry loop marks the context (see
// transport/_infra/classify/retry.ts): the wedged socket still looks healthy
// to the pool, so reusing it stalls every retry. keepalive:false forces a
// fresh connection for the remaining attempts of that request.
export function connectionInit(ctx: RequestContext): { keepalive: false } | Record<never, never> {
  return ctx.freshConnection === true ? { keepalive: false } : {};
}

export function connectionHeaders(ctx: RequestContext): Record<string, string> {
  return ctx.freshConnection === true ? { Connection: "close" } : {};
}
