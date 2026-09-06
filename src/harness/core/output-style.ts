import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";

export const outputStyleLayer: CategorizedLayer = {
  name: "output-style",
  kind: "system",
  cache: "1h",
  phase: "dynamic",
  render(ctx: LayerContext) {
    const style = ctx.outputStyle;
    if (style === null) return null;
    return `# Output Style: ${style.name}\n${style.prompt}`;
  },
};
