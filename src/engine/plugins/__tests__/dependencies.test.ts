import { describe, expect, test } from "bun:test";
import {
  type DependencyPlugin,
  dependencyClosure,
  qualifyDependency,
  requiredByWarning,
  reverseDependents,
} from "@/engine/plugins/dependencies.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";

function entry(
  name: string,
  marketplace: string,
  options?: { dependencies?: string[]; enabled?: boolean },
): DependencyPlugin {
  return {
    pluginId: `${name}@${marketplace}`,
    enabled: options?.enabled ?? true,
    plugin: {
      name,
      source: `${name}@${marketplace}`,
      path: `/fixtures/${name}`,
      manifest: {
        name,
        ...(options?.dependencies ? { dependencies: options.dependencies } : {}),
      },
    } as unknown as LoadedPlugin,
  };
}

describe("qualifyDependency", () => {
  test("bare names inherit the declarer's marketplace; qualified ids pass through", () => {
    expect(qualifyDependency("base", "app@market")).toBe("base@market");
    expect(qualifyDependency("base@other", "app@market")).toBe("base@other");
  });
});

describe("reverseDependents", () => {
  test("finds enabled plugins requiring the target by id or bare name", () => {
    const all = [
      entry("base", "market"),
      entry("app", "market", { dependencies: ["base"] }),
      entry("tool", "other", { dependencies: ["base@market"] }),
      entry("off", "market", { dependencies: ["base"], enabled: false }),
    ];
    expect(reverseDependents("base@market", all).sort()).toEqual(["app", "tool"]);
  });

  test("empty when nothing requires the target", () => {
    const all = [entry("base", "market"), entry("app", "market")];
    expect(reverseDependents("base@market", all)).toEqual([]);
  });
});

describe("dependencyClosure", () => {
  test("walks transitively, dedupes, and reports missing entries", () => {
    const all = [
      entry("app", "market", { dependencies: ["mid", "ghost"] }),
      entry("mid", "market", { dependencies: ["leaf"] }),
      entry("leaf", "market"),
    ];
    const result = dependencyClosure("app@market", all);
    expect(result.closure).toEqual(["mid@market", "leaf@market"]);
    expect(result.missing).toEqual(["ghost@market"]);
  });

  test("cycles terminate without duplication", () => {
    const all = [
      entry("a", "market", { dependencies: ["b"] }),
      entry("b", "market", { dependencies: ["a"] }),
    ];
    const result = dependencyClosure("a@market", all);
    expect(result.closure).toEqual(["b@market"]);
    expect(result.missing).toEqual([]);
  });
});

describe("requiredByWarning", () => {
  test("formats the dependents suffix", () => {
    expect(requiredByWarning([])).toBe("");
    expect(requiredByWarning(["app", "tool"])).toBe(" — warning: required by app, tool");
  });
});
