import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const srcRoot = join(import.meta.dir, "..");
const importPattern =
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const backendEngineAllowlist = new Set<string>();
const kernelFloorAllowlist: Array<{ file: string; specifier: string; reason: string }> = [];

const infraImportAllowlist = new Map<string, string>([
  [
    "design/capabilities/llm-stream.ts imports @/engine/tools/_infra/command-analysis/destructive.ts",
    "existing design bridge import pending engine tools public surface",
  ],
  [
    "design/capabilities/llm-stream.ts imports @/engine/transport/_infra/classify/retry.ts",
    "existing design bridge import pending engine transport public surface",
  ],
  [
    "main.ts imports @/engine/transport/_infra/classify/classifiers/index.ts",
    "existing main wiring import pending engine transport public surface",
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if ((path.endsWith(".ts") || path.endsWith(".tsx")) && !path.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

function repoPath(path: string): string {
  return relative(srcRoot, path).split("\\").join("/");
}

function importsIn(path: string): Array<{ line: number; specifier: string }> {
  const text = readFileSync(path, "utf8");
  const out: Array<{ line: number; specifier: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    importPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(line))) {
      const specifier = match[1] ?? match[2];
      if (specifier) out.push({ line: i + 1, specifier });
    }
  }
  return out;
}

function importOffenders(
  root: string,
  blocked: (specifier: string, file: string) => boolean,
): string[] {
  return sourceFiles(join(srcRoot, root)).flatMap((file) =>
    importsIn(file)
      .filter(({ specifier }) => blocked(specifier, file))
      .map(({ line, specifier }) => `${repoPath(file)}:${line} imports ${specifier}`),
  );
}

function moduleRootOf(path: string): string {
  return path.split("/", 1)[0] ?? "";
}

function sourceImportTarget(file: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (!specifier.startsWith(".")) return null;

  const target = normalize(resolve(dirname(file), specifier));
  const relativeTarget = relative(srcRoot, target);
  if (relativeTarget.startsWith("..")) return null;
  return relativeTarget.split("\\").join("/");
}

function allSourceFiles(): string[] {
  return sourceFiles(srcRoot);
}

describe("import boundaries", () => {
  it("keeps runtime engine code independent of outer layers", () => {
    const offenders = importOffenders(
      "engine",
      (specifier) =>
        specifier.startsWith("@/backend") ||
        specifier.startsWith("@/store") ||
        specifier.startsWith("@/ui"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps backend off engine internals", () => {
    const offenders = importOffenders("backend", (specifier) => {
      if (!specifier.startsWith("@/engine")) return false;
      return !backendEngineAllowlist.has(specifier);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps kernel independent of outer layers", () => {
    const allowlist = new Set(
      kernelFloorAllowlist.map(({ file, specifier }) => `${file} imports ${specifier}`),
    );
    const offenders = importOffenders(
      "kernel",
      (specifier) =>
        specifier.startsWith("@/engine") ||
        specifier.startsWith("@/store") ||
        specifier.startsWith("@/ui") ||
        specifier.startsWith("@/backend") ||
        specifier.startsWith("@/harness"),
    ).filter((entry) => !allowlist.has(entry.replace(/:\d+ /, " ")));
    expect(offenders).toEqual([]);
  });

  it("keeps kernel/std a leaf of the kernel", () => {
    const stdRoot = "kernel/std/";
    const offenders = allSourceFiles()
      .filter((file) => repoPath(file).startsWith(stdRoot))
      .flatMap((file) =>
        importsIn(file)
          .map(({ line, specifier }) => ({
            line,
            specifier,
            target: sourceImportTarget(file, specifier),
          }))
          .filter(({ specifier, target }) => {
            if (specifier.startsWith("@/kernel/")) {
              return !specifier.startsWith("@/kernel/std");
            }
            if (target === null) return false;
            return target.startsWith("kernel/") && !target.startsWith(stdRoot);
          })
          .map(({ line, specifier }) => `${repoPath(file)}:${line} imports ${specifier}`),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps store free of ui imports", () => {
    const offenders = importOffenders("store", (specifier) => specifier.startsWith("@/ui"));
    expect(offenders).toEqual([]);
  });

  it("keeps harness off engine, ui, and backend internals", () => {
    const offenders = importOffenders(
      "harness",
      (specifier) =>
        specifier.startsWith("@/engine") ||
        specifier.startsWith("@/ui") ||
        specifier.startsWith("@/backend"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps engine off ui and backend internals", () => {
    const offenders = importOffenders(
      "engine",
      (specifier) => specifier.startsWith("@/ui") || specifier.startsWith("@/backend"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps backend surface subtrees independent", () => {
    const appOffenders = importOffenders("backend/app", (specifier) =>
      specifier.startsWith("@/backend/design"),
    );
    const designOffenders = importOffenders("backend/design", (specifier) =>
      specifier.startsWith("@/backend/app"),
    );
    const bridgeOffenders = importOffenders("design", (specifier) =>
      specifier.startsWith("@/backend/app"),
    );
    expect([...appOffenders, ...designOffenders, ...bridgeOffenders]).toEqual([]);
  });

  it("keeps module _infra directories private", () => {
    const offenders = allSourceFiles()
      .flatMap((file) =>
        importsIn(file)
          .map(({ line, specifier }) => ({
            line,
            specifier,
            target: sourceImportTarget(file, specifier),
          }))
          .filter(({ target }) => target !== null && /\/_infra\//.test(target))
          .filter(({ target }) => moduleRootOf(repoPath(file)) !== moduleRootOf(target ?? ""))
          .map(({ line, specifier }) => `${repoPath(file)}:${line} imports ${specifier}`),
      )
      .filter((entry) => !infraImportAllowlist.has(entry.replace(/:\d+ /, " ")));

    expect(offenders).toEqual([]);
  });

  it("keeps store root free of new loose files", () => {
    const looseFiles = readdirSync(join(srcRoot, "store"))
      .map((entry) => join(srcRoot, "store", entry))
      .filter((path) => statSync(path).isFile())
      .map(repoPath)
      .filter((path) => path !== "store/index.ts");
    expect(looseFiles).toEqual([]);
  });

  it("routes render-layer imports through the @/terminal-runtime barrel", () => {
    // The view tier (src/ui) composes render primitives at module level — the same
    // shape the pi-tui string model uses, where a component imports the text, focus,
    // and component modules it renders with. Only layers outside the render + view
    // tiers must reach the render layer through the barrel surface.
    const offenders = allSourceFiles()
      .filter((file) => !repoPath(file).startsWith("terminal-runtime/"))
      .filter((file) => !repoPath(file).startsWith("ui/"))
      .flatMap((file) =>
        importsIn(file)
          .filter(({ specifier }) => specifier.startsWith("@/terminal-runtime/"))
          .map(
            ({ line, specifier }) =>
              `${repoPath(file)}:${line} imports ${specifier} — import the render layer through the @/terminal-runtime barrel`,
          ),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps render dependencies inside terminal-runtime", () => {
    const renderPackages = [
      "@alcalzone/ansi-tokenize",
      "ansi-escapes",
      "ansi-styles",
      "bidi-js",
      "chalk",
      "cli-truncate",
      "emoji-regex",
      "get-east-asian-width",
      "slice-ansi",
      "widest-line",
      "wrap-ansi",
    ] as const;
    const offenders = allSourceFiles()
      .filter((file) => !repoPath(file).startsWith("terminal-runtime/"))
      // Tests reconstruct expected styled output straight from a render package as an
      // independent oracle; production code stays behind the barrel's style helpers.
      .filter((file) => !repoPath(file).includes("/__tests__/"))
      .flatMap((file) =>
        importsIn(file)
          .filter(({ specifier }) =>
            renderPackages.some(
              (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
            ),
          )
          .map(({ line, specifier }) => `${repoPath(file)}:${line} imports ${specifier}`),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps the Yoga vendor behind its geometry adapter", () => {
    const adapter = "terminal-runtime/geometry/yoga-adapter.ts";
    const vendorRoot = "terminal-runtime/geometry/vendor/yoga-layout/";
    const offenders = allSourceFiles()
      .filter((file) => repoPath(file) !== adapter && !repoPath(file).startsWith(vendorRoot))
      .flatMap((file) =>
        importsIn(file)
          .map(({ line, specifier }) => ({
            line,
            specifier,
            target: sourceImportTarget(file, specifier),
          }))
          .filter(({ target }) => target?.startsWith(vendorRoot))
          .map(({ line, specifier }) => `${repoPath(file)}:${line} imports ${specifier}`),
      );
    expect(offenders).toEqual([]);
  });
});
