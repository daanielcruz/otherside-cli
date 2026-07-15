import { describe, expect, test } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { buildStatuslineInput, renderNativeStatusline } from "./line-input.ts";

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
