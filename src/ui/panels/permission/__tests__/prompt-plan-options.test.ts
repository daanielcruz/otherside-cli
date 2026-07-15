import { describe, expect, it } from "bun:test";
import { buildGenericOptions, planOptionsFor } from "../prompt.tsx";

describe("planOptionsFor (ExitPlanMode option construction)", () => {
  it("offers a yolo bypass first when the pre-plan mode was yolo", () => {
    const options = planOptionsFor(true);

    expect(options).toEqual([
      { key: "1", label: "Yes, and bypass permissions", kind: "plan_bypass" },
      { key: "2", label: "Yes, manually approve edits", kind: "plan_default" },
      { key: "3", label: "Tell Otherside what to change", kind: "plan_feedback" },
    ]);
  });

  it("offers auto-accept-edits first when bypass is unavailable", () => {
    const options = planOptionsFor(false);

    expect(options).toEqual([
      { key: "1", label: "Yes, and use auto mode", kind: "plan_accept_edits" },
      { key: "2", label: "Yes, manually approve edits", kind: "plan_default" },
      { key: "3", label: "Tell Otherside what to change", kind: "plan_feedback" },
    ]);
  });

  it("always keeps 'manually approve edits' wired to default, not accept-edits", () => {
    for (const bypassAvailable of [true, false]) {
      const manualOption = planOptionsFor(bypassAvailable)[1];
      expect(manualOption?.label).toBe("Yes, manually approve edits");
      expect(manualOption?.kind).toBe("plan_default");
    }
  });
});

describe("generic permission option construction", () => {
  it("offers a session-wide edit grant instead of persisting one path", () => {
    expect(buildGenericOptions("Write(src/example.ts)", false, "Write")).toEqual([
      { key: "1", label: "Yes", kind: "allow" },
      {
        key: "2",
        label: "Yes, allow all edits during this session",
        kind: "allow_session_edits",
      },
      { key: "3", label: "No", kind: "deny" },
    ]);
  });

  it("assigns unique quick keys when read and persistent options coexist", () => {
    const options = buildGenericOptions("Read(/outside/file)", false, "Read", true);
    expect(options.map((option) => option.key)).toEqual(["1", "2", "3", "4"]);
    expect(options[1]).toEqual({
      key: "2",
      label: "Yes, during this session",
      kind: "allow_session",
    });
    expect(new Set(options.map((option) => option.key)).size).toBe(options.length);
  });
});
