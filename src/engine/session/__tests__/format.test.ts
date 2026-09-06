import { beforeAll, describe, expect, it } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { formatQuotaPercent, formatQuotaWarningMessage } from "../usage/format.ts";

beforeAll(() => registerAllProviders());

describe("formatQuotaPercent", () => {
  it("renders whole numbers without a decimal", () => {
    expect(formatQuotaPercent(100)).toBe("100");
    expect(formatQuotaPercent(0)).toBe("0");
    expect(formatQuotaPercent(70)).toBe("70");
  });

  it("preserves a meaningful decimal", () => {
    expect(formatQuotaPercent(99.9)).toBe("99.9");
    expect(formatQuotaPercent(87.36)).toBe("87.4");
  });

  it("clamps out-of-range values into 0..100", () => {
    expect(formatQuotaPercent(150)).toBe("100");
    expect(formatQuotaPercent(-5)).toBe("0");
  });
});

describe("formatQuotaWarningMessage (central per-scope template)", () => {
  it("renders the exact `[provider display name] pct% Window · resets <time>` template", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const message = formatQuotaWarningMessage("codex", 87, "primary", future);
    expect(message.startsWith("[Codex] 87% Usage · resets ")).toBe(true);
    expect(message).not.toContain("resets unknown");
  });

  it("preserves a meaningful decimal in the percent segment", () => {
    const message = formatQuotaWarningMessage("codex", 99.9, "spark", null);
    expect(message).toBe("[Codex] 99.9% Spark · resets unknown");
  });

  it("renders 'unknown' for a null reset", () => {
    expect(formatQuotaWarningMessage("anthropic", 100, "seven_day_fable", null)).toBe(
      "[Anthropic] 100% Fable weekly · resets unknown",
    );
  });

  it("renders 'unknown' for an undefined reset", () => {
    expect(formatQuotaWarningMessage("anthropic", 71, "seven_day", undefined)).toBe(
      "[Anthropic] 71% Weekly · resets unknown",
    );
  });

  it("renders 'unknown' for a reset already in the past", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(formatQuotaWarningMessage("codex", 100, "primary", past)).toBe(
      "[Codex] 100% Usage · resets unknown",
    );
  });

  it("renders 'unknown' for an unparseable reset string", () => {
    expect(formatQuotaWarningMessage("codex", 80, "secondary", "not-a-date")).toBe(
      "[Codex] 80% Secondary usage · resets unknown",
    );
  });

  it("accepts an ISO string reset and formats a short (non-unknown) time", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const message = formatQuotaWarningMessage("antigravity", 95, "gemini", future);
    expect(message.startsWith("[Antigravity] 95% Gemini · resets ")).toBe(true);
    expect(message).not.toContain("resets unknown");
  });

  it("receives provider and window as separate plain-text inputs (no provider-specific sentence)", () => {
    const message = formatQuotaWarningMessage("codex", 100, "claude-gpt", null);
    expect(message).toBe("[Codex] 100% Claude/GPT · resets unknown");
  });

  it("uses neutral fallback labels when Codex window duration is unavailable", () => {
    expect(formatQuotaWarningMessage("codex", 92, "primary", null)).toBe(
      "[Codex] 92% Usage · resets unknown",
    );
    expect(formatQuotaWarningMessage("codex", 80, "Codex weekly limit", null)).toBe(
      "[Codex] 80% Weekly · resets unknown",
    );
    expect(formatQuotaWarningMessage("codex", 55, "secondary", null)).toBe(
      "[Codex] 55% Secondary usage · resets unknown",
    );
  });

  it("normalizes Kimi weekly and duration labels", () => {
    expect(formatQuotaWarningMessage("kimi", 71, "Weekly limit", null)).toBe(
      "[Kimi] 71% Weekly · resets unknown",
    );
    expect(formatQuotaWarningMessage("kimi", 40, "Kimi 5h limit", null)).toBe(
      "[Kimi] 40% Session · resets unknown",
    );
  });

  it("normalizes MiniMax general/video window labels", () => {
    expect(formatQuotaWarningMessage("minimax", 88, "general · weekly", null)).toBe(
      "[MiniMax] 88% General · weekly · resets unknown",
    );
    expect(formatQuotaWarningMessage("minimax", 12, "video · 5-hour", null)).toBe(
      "[MiniMax] 12% Video · session · resets unknown",
    );
  });

  it("normalizes Z.AI and xAI plan labels", () => {
    expect(formatQuotaWarningMessage("glm", 96, "Weekly quota", null)).toBe(
      "[Z.AI] 96% Weekly · resets unknown",
    );
    expect(formatQuotaWarningMessage("glm", 3, "MCP quota", null)).toBe(
      "[Z.AI] 3% MCP · resets unknown",
    );
    expect(formatQuotaWarningMessage("glm", 0, "5-hour prompt pool", null)).toBe(
      "[Z.AI] 0% Session · resets unknown",
    );
    expect(formatQuotaWarningMessage("xai", 17, "Monthly credits", null)).toBe(
      "[xAI] 17% Monthly · resets unknown",
    );
  });
});
