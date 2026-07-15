import { defaultEffortForModel, effortLevelsForModel } from "@/engine/model/catalog.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export function withLiveBrokerEffort(ctx: RequestContext): RequestContext {
  const live = ctx.broker?.read().effort;
  if (live === undefined) return ctx;
  const effort =
    live !== null && !effortLevelsForModel(ctx.model, ctx.provider).includes(live)
      ? defaultEffortForModel(ctx.model, ctx.provider)
      : live;
  return effort === ctx.effort ? ctx : { ...ctx, effort };
}
