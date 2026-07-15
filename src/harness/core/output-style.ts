import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";
import { BUILT_IN_OUTPUT_STYLES } from "@/harness/routines/output-styles/built-in.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

function loadOutputStyleContent(name: string): string | null {
  const root = configRoot();
  const candidates = [
    join(root, "output-styles", `${name}.md`),
    join(root, "output-styles", name, "STYLE.md"),
  ];
  for (const path of candidates) {
    try {
      if (existsSync(path)) return readFileSync(path, "utf8").trim();
    } catch {}
  }
  return BUILT_IN_OUTPUT_STYLES[name] ?? null;
}

export const outputStyleLayer: CategorizedLayer = {
  name: "output-style",
  kind: "system",
  cache: "1h",
  phase: "dynamic",
  render(ctx: LayerContext) {
    const style = ctx.config.outputStyle!.trim();
    const content = loadOutputStyleContent(style);
    if (content) return `# Output Style: ${style}\n\n${content}`;
    return `# Output Style: ${style}\n\nFollow the conventions of the "${style}" output style throughout this session.`;
  },
};
