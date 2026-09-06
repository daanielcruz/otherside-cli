import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  buildStatuslineInput,
  nextOrchestrationNotice,
  renderNativeStatusline,
  resetOrchestrationNoticeState,
} from "../line-input.ts";

registerAllProviders();

describe("statusline context usage", () => {
  test("counts assistant output against the next context window", () => {
    const input = buildStatuslineInput({
      state: {
        provider: "xai",
        model: "grok-4.5",
        permissionMode: "default",
      } as never,
      sessionId: "s1",
      version: "test",
      cwd: "/repo",
      inputTokens: 447_000,
      outputTokens: 84_603,
    });

    expect(input.context_window.context_window_size).toBe(500_000);
    expect(input.context_window.used_percentage).toBe(100);
    expect(renderNativeStatusline(input)).toContain("0K available");
  });
});

describe("statusline output style", () => {
  const baseArgs = {
    state: { provider: "xai", model: "grok-4.5", permissionMode: "default" } as never,
    sessionId: "s1",
    version: "test",
    cwd: "/repo",
  };

  test("reports the default style when none is configured", () => {
    expect(buildStatuslineInput(baseArgs).output_style).toEqual({ name: "default" });
  });

  test("reports the configured style by name", () => {
    expect(buildStatuslineInput({ ...baseArgs, outputStyle: "Proactive" }).output_style).toEqual({
      name: "Proactive",
    });
  });
});

describe("orchestration notice dedup", () => {
  beforeEach(() => {
    resetOrchestrationNoticeState();
  });

  afterEach(() => {
    resetOrchestrationNoticeState();
  });

  test("fires the startup notice once and never for repeated observations", () => {
    expect(nextOrchestrationNotice("default")).toBe(
      "Multiprovider orchestration is active in default mode",
    );
    expect(nextOrchestrationNotice("default")).toBeNull();
    expect(nextOrchestrationNotice("default")).toBeNull();
  });

  test("stays silent at startup when orchestration is disabled", () => {
    expect(nextOrchestrationNotice("disabled")).toBeNull();
    expect(nextOrchestrationNotice("disabled")).toBeNull();
  });

  test("fires exactly once per mode switch, including switching off", () => {
    expect(nextOrchestrationNotice("default")).not.toBeNull();
    expect(nextOrchestrationNotice("feudalism")).toBe(
      "Multiprovider orchestration set to feudalism mode",
    );
    expect(nextOrchestrationNotice("feudalism")).toBeNull();
    expect(nextOrchestrationNotice("disabled")).toBe("Multiprovider orchestration disabled");
    expect(nextOrchestrationNotice("disabled")).toBeNull();
  });

  test("announces enabling after a disabled startup as a switch", () => {
    expect(nextOrchestrationNotice("disabled")).toBeNull();
    expect(nextOrchestrationNotice("default")).toBe(
      "Multiprovider orchestration set to default mode",
    );
  });
});
