import { settleEffortForModel } from "@/engine/model/catalog.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export function withLiveBrokerEffort(ctx: RequestContext): RequestContext {
  const live = ctx.broker?.read().effort;
  if (live === undefined) return ctx;
  const effort = settleEffortForModel(ctx, live);
  return effort === ctx.effort ? ctx : { ...ctx, effort };
}
