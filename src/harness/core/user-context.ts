import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";
import { renderUserContextInner } from "@/harness/reminders/reminders.ts";

export const userContextLayer: CategorizedLayer = {
  name: "user-context",
  kind: "user",
  bundleKey: "user-context",
  render(ctx: LayerContext) {
    const memory = ctx.memorySection ?? null;
    const out: { currentDate?: string; memory?: string } = {};
    if (ctx.currentDate !== undefined) out.currentDate = ctx.currentDate;
    if (memory !== null) out.memory = memory;
    return renderUserContextInner(out).trim();
  },
};
