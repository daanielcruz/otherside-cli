import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";
import { renderDeferredToolsReminder } from "@/harness/reminders/reminders.ts";

export const deferredToolsLayer: CategorizedLayer = {
  name: "deferred-tools",
  kind: "mid-system",
  render(ctx: LayerContext) {
    return renderDeferredToolsReminder(ctx.deferredToolNames ?? [], ctx.deferredToolExclusions, [
      ...(ctx.deferredMcpToolNames ?? []),
    ]).trim();
  },
};
