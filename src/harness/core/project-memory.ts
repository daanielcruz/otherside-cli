import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";

export const projectMemoryLayer: CategorizedLayer = {
  name: "project-memory",
  kind: "user",
  render(ctx: LayerContext) {
    return ctx.projectMemorySection ?? null;
  },
};
