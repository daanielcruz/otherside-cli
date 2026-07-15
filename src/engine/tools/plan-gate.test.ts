import { describe, expect, test } from "bun:test";
import { activePlanFilePath, isActivePlanFileWrite } from "@/engine/tools/plan-gate.ts";

const ctx = { sessionId: "session-1", cwd: "/tmp/project" };

describe("plan file helpers", () => {
  test("builds a stable absolute plan path for the session", () => {
    const planFile = activePlanFilePath(ctx.sessionId);

    expect(planFile).toEndWith("/plans/session-1.md");
  });

  test("recognizes the active plan file as the internal Write target", () => {
    expect(isActivePlanFileWrite({ file_path: activePlanFilePath(ctx.sessionId) }, ctx)).toBe(true);
  });

  for (const input of [{ file_path: "/tmp/elsewhere.md" }, { file_path: "relative-plan.md" }, {}]) {
    test(`rejects a non-plan target: ${JSON.stringify(input)}`, () => {
      expect(isActivePlanFileWrite(input, ctx)).toBe(false);
    });
  }
});
