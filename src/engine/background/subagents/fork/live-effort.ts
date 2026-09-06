import { defaultEffortForModel, effortLevelsForModel } from "@/engine/model/catalog.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export function withLiveBrokerEffort(ctx: RequestContext): RequestContext {
  const live = ctx.broker?.read().effort;
  if (live === undefined) return ctx;
  const effort =
    live !== null &&
    !effortLevelsForModel({ provider: ctx.provider, model: ctx.model }).includes(live)
      ? defaultEffortForModel({ provider: ctx.provider, model: ctx.model })
      : live;
  return effort === ctx.effort ? ctx : { ...ctx, effort };
}
