import { describe, expect, it } from "bun:test";
import { cdRuleRefusalMessage, checkCdPermission } from "@/kernel/permissions/cd.ts";
import type { PermissionRule } from "@/kernel/permissions/types.ts";

describe("checkCdPermission", () => {
  it("allows when no Cd rules exist", () => {
    const result = checkCdPermission(
      { requestedPath: "/tmp/a", canonicalPath: "/tmp/a" },
      { rules: [], baseCwd: "/tmp" },
    );
    expect(result).toEqual({ result: "allowed" });
  });

  it("blocks whole-tool Cd deny", () => {
    const rule: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "Cd" },
    };
    const result = checkCdPermission(
      { requestedPath: "/tmp/a", canonicalPath: "/tmp/a" },
      { rules: [rule], baseCwd: "/tmp" },
    );
    expect(result.result).toBe("blockedByRule");
    if (result.result === "blockedByRule") {
      const msg = cdRuleRefusalMessage("/tmp/a", result);
      expect(msg).toContain("/cd is turned off");
      expect(msg).toContain("user settings");
    }
  });

  it("enforces allowlist patterns when present", () => {
    const allow: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "Cd", ruleContent: "pkgs/**" },
    };
    const base = "/workspace";
    const denied = checkCdPermission(
      { requestedPath: "/workspace/other", canonicalPath: "/workspace/other" },
      { rules: [allow], baseCwd: base },
    );
    expect(denied.result).toBe("outsideAllowedPatterns");

    const ok = checkCdPermission(
      { requestedPath: "/workspace/pkgs/foo", canonicalPath: "/workspace/pkgs/foo" },
      { rules: [allow], baseCwd: base },
    );
    expect(ok.result).toBe("allowed");
  });
});
