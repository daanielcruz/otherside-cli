import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const sourceRoots = [join(repoRoot, "src/ui/panels"), join(repoRoot, "src/ui/chrome")];
const listWindowSource = join(repoRoot, "src/kernel/std/list-window.ts");
const windowFunctionPattern = /function\s+\w*[wW]indow(Start)?\s*\(/;
const windowAllowlist = new Set([
  "src/kernel/std/list-window.ts",
  "src/ui/panels/plugins/pagination.ts",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if ((path.endsWith(".ts") || path.endsWith(".tsx")) && !path.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

function repoPath(path: string): string {
  return relative(repoRoot, path).split("\\").join("/");
}

const panelSources = [...sourceRoots.flatMap(sourceFiles), listWindowSource];

describe("panel source-of-truth boundaries", () => {
  it("keeps window calculations in computeListWindow", () => {
    const offenders = panelSources
      .filter((file) => !windowAllowlist.has(repoPath(file)))
      .filter((file) => windowFunctionPattern.test(readFileSync(file, "utf8")))
      .map(repoPath);

    expect(offenders, `Use computeListWindow instead: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps horizontal dividers in PanelDivider", () => {
    const offenders = panelSources
      .filter((file) => repoPath(file) !== "src/ui/chrome/panel.tsx")
      .filter((file) => readFileSync(file, "utf8").includes("Glyph.boxHLine.repeat"))
      .map(repoPath);

    expect(offenders, `Use PanelDivider instead: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps panel padding in FooterPanel", () => {
    const offenders = sourceRoots
      .flatMap(sourceFiles)
      .filter((file) => readFileSync(file, "utf8").includes("paddingX={3}"))
      .map(repoPath);

    expect(offenders, `Use FooterPanel instead: ${offenders.join(", ")}`).toEqual([]);
  });
});
