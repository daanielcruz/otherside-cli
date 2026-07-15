import { describe, expect, test } from "bun:test";
import { designTurnFailureMessage } from "@/design/capabilities/llm-stream.ts";

describe("designTurnFailureMessage — design turn RPC error mapping", () => {
  test("quota exhaustion maps to an actionable limit message", () => {
    const message = designTurnFailureMessage(
      {
        output: "quota exhausted for zai/glm-4.7: You've hit your limit",
        quotaExhausted: {
          provider: "zai",
          model: "glm-4.7",
          resetEpochMs: null,
          message: "You've hit your limit",
        },
      },
      "zai",
      "glm-4.7",
    );
    expect(message).toBe(
      "Provider usage limit reached (zai/glm-4.7). Switch the model in the CLI or wait for the limit to reset.",
    );
  });

  test("quota message names the provider/model that actually exhausted", () => {
    const message = designTurnFailureMessage(
      {
        output: "",
        quotaExhausted: {
          provider: "codex",
          model: "gpt-5.5",
          resetEpochMs: 1234,
          message: "usage limit",
        },
      },
      "zai",
      "glm-4.7",
    );
    expect(message).toContain("codex/gpt-5.5");
  });

  test("internal fork errors are replaced at the RPC boundary", () => {
    const sensitivePath = "/Users/alice/.otherside/private/snapshot.json";
    const message = designTurnFailureMessage(
      { output: `fork error: unable to read ${sensitivePath}` },
      "zai",
      "glm-4.7",
    );
    expect(message).toBe("The model stream failed (zai/glm-4.7). Try again.");
    expect(message).not.toContain(sensitivePath);
  });

  test("empty output falls back to a specific stream-failure message", () => {
    const message = designTurnFailureMessage({ output: "" }, "zai", "glm-4.7");
    expect(message).toBe("The model stream failed (zai/glm-4.7). Try again.");
  });

  test("fork error with empty detail falls back too", () => {
    const message = designTurnFailureMessage({ output: "fork error: " }, "zai", "glm-4.7");
    expect(message).toBe("The model stream failed (zai/glm-4.7). Try again.");
  });

  test("stall output passes through unchanged", () => {
    const message = designTurnFailureMessage(
      { output: "stalled — no progress for 90000ms" },
      "zai",
      "glm-4.7",
    );
    expect(message).toBe("stalled — no progress for 90000ms");
  });
});
