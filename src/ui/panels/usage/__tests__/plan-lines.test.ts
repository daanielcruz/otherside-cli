import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { emptyProviderUsage } from "@/engine/session/usage/provider.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { antigravityPlanLines } from "../plan-lines.ts";

describe("Antigravity usage errors", () => {
  const previousForceHyperlink = process.env.FORCE_HYPERLINK;

  beforeAll(() => {
    process.env.FORCE_HYPERLINK = "1";
  });

  afterAll(() => {
    if (previousForceHyperlink === undefined) delete process.env.FORCE_HYPERLINK;
    else process.env.FORCE_HYPERLINK = previousForceHyperlink;
  });

  it("keep the page that verifies the account whole and linked", () => {
    const verifyAt = `https://accounts.google.com/signin/continue?plt=${"q".repeat(120)}`;
    const lines = antigravityPlanLines(
      {
        status: "error",
        data: null,
        message: `Verify your account to continue. — verify at ${verifyAt}`,
      },
      "antigravity",
      "gemini-3.8-flash",
      emptyProviderUsage(),
      emptyProviderUsage(),
      80,
      60,
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map(stripAnsi).join("")).toContain(verifyAt);
    for (const line of lines.filter((row) => /q{10}/.test(stripAnsi(row)))) {
      expect(line).toContain(`\x1b]8;;${verifyAt}`);
    }
  });
});
