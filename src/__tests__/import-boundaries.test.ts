import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const srcRoot = join(import.meta.dir, "..");
const importPattern =
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const remoteEngineAllowlist = new Set<string>();
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
    "design/relay/outbound.ts imports @/remote/_infra/cortex.ts",
    "existing design relay import pending remote public surface",
  ],
  [
    "design/relay/relay.ts imports @/remote/_infra/realtime.ts",
    "existing design relay import pending remote public surface",
  ],
  [
    "design/relay/wire.ts imports @/remote/_infra/cortex.ts",
    "existing design relay import pending remote public surface",
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
        specifier.startsWith("@/remote") ||
        specifier.startsWith("@/store") ||
        specifier.startsWith("@/ui"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps remote off engine internals", () => {
    const offenders = importOffenders("remote", (specifier) => {
      if (!specifier.startsWith("@/engine")) return false;
      return !remoteEngineAllowlist.has(specifier);
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
        specifier.startsWith("@/remote") ||
        specifier.startsWith("@/harness"),
    ).filter((entry) => !allowlist.has(entry.replace(/:\d+ /, " ")));
    expect(offenders).toEqual([]);
  });

  it("keeps store free of ui imports", () => {
    const offenders = importOffenders("store", (specifier) => specifier.startsWith("@/ui"));
    expect(offenders).toEqual([]);
  });

  it("keeps harness off engine, ui, and remote internals", () => {
    const offenders = importOffenders(
      "harness",
      (specifier) =>
        specifier.startsWith("@/engine") ||
        specifier.startsWith("@/ui") ||
        specifier.startsWith("@/remote"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps engine off ui and remote internals", () => {
    const offenders = importOffenders(
      "engine",
      (specifier) => specifier.startsWith("@/ui") || specifier.startsWith("@/remote"),
    );
    expect(offenders).toEqual([]);
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
});
