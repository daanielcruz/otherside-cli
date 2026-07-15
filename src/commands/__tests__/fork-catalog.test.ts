import { describe, expect, test } from "bun:test";
import { buildCatalog } from "@/commands/catalog.ts";
import { lookup } from "@/commands/dispatch.ts";
import { isImmediateSlash } from "@/commands/immediate.ts";

describe("/fork catalog", () => {
  test("is registered with a compact description and the reference argument hint", () => {
    const fork = buildCatalog().find((c) => c.name === "fork");
    expect(fork).toBeDefined();
    expect(fork?.kind).toBe("instant");
    expect(fork?.description).toBe("spawn an inherited background agent");
    expect(fork?.argumentHint).toBe("<directive>");
    expect(lookup("fork")?.name).toBe("fork");
  });

  test("is immediate so mid-turn /fork is not queued", () => {
    expect(isImmediateSlash("/fork review auth")).toBe(true);
  });
});
