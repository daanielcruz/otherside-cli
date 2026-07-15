import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";
import INVESTIGATE_FIRST_DYNAMIC_SECTION from "@/harness/reminders/investigate-first/section.md" with {
  type: "text",
};

export { INVESTIGATE_FIRST_DYNAMIC_SECTION };

export type InvestigateFirstMode = "off" | "additive" | "compact";

export function investigateFirstMode(model: string | undefined): InvestigateFirstMode {
  if (!model) return "off";
  if (!model.startsWith("claude-opus-4-8")) return "off";

  const env = process.env.OTHERSIDE_INVESTIGATE_FIRST?.trim().toLowerCase();

  if (env === "additive" || env === "compact") return env;
  if (env === "1" || env === "true" || env === "yes") return "additive";

  return "off";
}

export const investigateFirstLayer: CategorizedLayer = {
  name: "investigate-first",
  kind: "system",
  cache: "1h",
  phase: "static",
  render(ctx: LayerContext) {
    if (investigateFirstMode(ctx.model) === "off") return null;
    return INVESTIGATE_FIRST_DYNAMIC_SECTION;
  },
};
