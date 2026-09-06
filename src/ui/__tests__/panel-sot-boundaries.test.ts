import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const sourceRoots = [join(repoRoot, "src/ui/panels"), join(repoRoot, "src/ui/chrome")];
const panelsRoot = join(repoRoot, "src/ui/panels");
const listWindowSource = join(repoRoot, "src/kernel/std/list-window.ts");
const windowFunctionPattern = /function\s+\w*[wW]indow(Start)?\s*\(/;
const windowAllowlist = new Set(["src/kernel/std/list-window.ts"]);

// Frozen offender lists: panels that still read the terminal size themselves or
// restate chrome-row counts locally. Later refactor phases shrink these to zero;
// new entries mean a panel bypassed the shared budget/window mechanisms.
const terminalRowsPattern = /process\.stdout\.rows/;
const terminalRowsAllowlist = new Set([
  "src/ui/panels/config/string-view.ts",
  "src/ui/panels/plugins/string-view.ts",
]);
const chromeRowsConstantPattern = /const\s+\w*(?:CHROME|PANEL_\w+)_ROWS\s*=/;
const chromeRowsConstantAllowlist = new Set<string>([]);

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

  it("keeps horizontal dividers in the panel builder", () => {
    const dividerOwners = new Set([
      "src/ui/chrome/string-view-panel.ts",
      "src/ui/chrome/__tests__/string-view-panel.test.ts",
    ]);
    const offenders = panelSources
      .filter((file) => !dividerOwners.has(repoPath(file)))
      .filter((file) => readFileSync(file, "utf8").includes("Glyph.boxHLine.repeat"))
      .map(repoPath);

    expect(offenders, `Use the panel builder instead: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps panel padding in FooterPanel", () => {
    const offenders = sourceRoots
      .flatMap(sourceFiles)
      .filter((file) => readFileSync(file, "utf8").includes("paddingX={3}"))
      .map(repoPath);

    expect(offenders, `Use FooterPanel instead: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps terminal-size reads out of new panel code", () => {
    const offenders = sourceFiles(panelsRoot)
      .filter((file) => !terminalRowsAllowlist.has(repoPath(file)))
      .filter((file) => terminalRowsPattern.test(readFileSync(file, "utf8")))
      .map(repoPath);

    expect(offenders, `Use the shared row budget instead: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps chrome-row constants out of new panel code", () => {
    const offenders = sourceFiles(panelsRoot)
      .filter((file) => !chromeRowsConstantAllowlist.has(repoPath(file)))
      .filter((file) => chromeRowsConstantPattern.test(readFileSync(file, "utf8")))
      .map(repoPath);

    expect(
      offenders,
      `Derive rows from the panel builder instead: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
