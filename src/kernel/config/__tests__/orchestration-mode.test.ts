import { describe, expect, it } from "bun:test";
import { normalizeConfig } from "@/kernel/config/config.ts";
import { descriptorFor } from "@/kernel/config/registry.ts";

describe("orchestration mode normalization", () => {
  it("accepts every canonical mode value", () => {
    for (const mode of ["disabled", "default", "feudalism"] as const) {
      expect(normalizeConfig({ orchestrationMode: mode }).orchestrationMode).toBe(mode);
    }
  });

  it("registers only the canonical field", () => {
    expect(descriptorFor("orchestrationMode")?.validate?.("default")).toBe("default");
    expect(descriptorFor("orchestrationMode")?.validate?.("soft")).toBeUndefined();
    expect(descriptorFor("tierSelectorEnabled" as never)).toBeUndefined();
    expect(descriptorFor("orchestratorMode" as never)).toBeUndefined();
  });
});
