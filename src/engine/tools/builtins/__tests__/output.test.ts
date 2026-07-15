import { afterEach, describe, expect, it } from "bun:test";
import { bashOutputCap, capHeadCombined, OUTPUT_CAP, OUTPUT_CAP_UPPER_LIMIT } from "../output.ts";

afterEach(() => {
  delete process.env.BASH_MAX_OUTPUT_LENGTH;
});

describe("bashOutputCap (BASH_MAX_OUTPUT_LENGTH)", () => {
  it("defaults to 30k when the env is unset", () => {
    expect(bashOutputCap()).toBe(OUTPUT_CAP);
  });

  it("honors a valid env override up to the upstream upper limit", () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = "150000";
    expect(bashOutputCap()).toBe(OUTPUT_CAP_UPPER_LIMIT);
    process.env.BASH_MAX_OUTPUT_LENGTH = "150001";
    expect(bashOutputCap()).toBe(OUTPUT_CAP_UPPER_LIMIT);
  });

  it("ignores a non-numeric or non-positive env value (fail-safe to default)", () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = "nope";
    expect(bashOutputCap()).toBe(OUTPUT_CAP);
    process.env.BASH_MAX_OUTPUT_LENGTH = "-5";
    expect(bashOutputCap()).toBe(OUTPUT_CAP);
  });

  it("capHeadCombined truncates at the default cap, but not under a raised cap", () => {
    const big = "x".repeat(OUTPUT_CAP + 100);
    expect(capHeadCombined(big, "").stdoutTruncated).toBe(true);
    process.env.BASH_MAX_OUTPUT_LENGTH = String(OUTPUT_CAP + 1000);
    expect(capHeadCombined(big, "").stdoutTruncated).toBe(false);
  });

  it("preserves the upstream head-only truncation marker", () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = "4";
    const result = capHeadCombined("head\n\n... [4 lines truncated] ...", "");
    expect(result.stdout).toBe("head\n\n... [4 lines truncated] ...");
    expect(result.stdoutTruncated).toBe(true);
  });
});

function oldCapHeadCombined(
  stdout: string,
  stderr: string,
  cap: number,
): {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
} {
  const outChars = Array.from(stdout);
  const stdoutTruncated = outChars.length > cap;
  const cappedStdout = stdoutTruncated ? outChars.slice(0, cap).join("") : stdout;
  const remaining = Math.max(0, cap - Math.min(outChars.length, cap));
  const errChars = Array.from(stderr);
  const stderrTruncated = errChars.length > remaining;
  const cappedStderr = stderrTruncated ? errChars.slice(0, remaining).join("") : stderr;
  return { stdout: cappedStdout, stderr: cappedStderr, stdoutTruncated, stderrTruncated };
}

describe("capHeadCombined optimizations", () => {
  afterEach(() => {
    delete process.env.BASH_MAX_OUTPUT_LENGTH;
  });

  it("code-unit pre-cap equivalence vs the previous algorithm", () => {
    const testCap = 100;
    process.env.BASH_MAX_OUTPUT_LENGTH = String(testCap);

    const testCases = [
      "",
      "hello",
      "a".repeat(50),
      "a".repeat(100),
      "a".repeat(101),
      "a".repeat(199),
      "a".repeat(200),
      "a".repeat(201),
      "a".repeat(500),
      "👾".repeat(49),
      "👾".repeat(50),
      "👾".repeat(51),
      "👾".repeat(100),
      "👾".repeat(101),
      "👾".repeat(200),
      "👾".repeat(201),
      "hello 👾 world ".repeat(20),
    ];

    for (const stdout of testCases) {
      for (const stderr of testCases) {
        const expected = oldCapHeadCombined(stdout, stderr, testCap);
        const actual = capHeadCombined(stdout, stderr);
        expect(actual.stdout).toBe(expected.stdout);
        expect(actual.stderr).toBe(expected.stderr);
        expect(actual.stdoutTruncated).toBe(expected.stdoutTruncated);
        expect(actual.stderrTruncated).toBe(expected.stderrTruncated);
      }
    }
  });

  it("astral-char boundary safety", () => {
    const testCap = 5;
    process.env.BASH_MAX_OUTPUT_LENGTH = String(testCap);

    const astral = "👾";

    const testCases = [
      astral.repeat(testCap),
      astral.repeat(testCap + 1),
      "a" + astral.repeat(testCap),
      astral.repeat(testCap) + "a",
      "a" + astral.repeat(testCap - 1) + "b" + astral,
      "ab" + astral.repeat(testCap),
      "abc" + astral.repeat(testCap),
      astral.repeat(testCap - 1) + "ab" + astral,
      astral.repeat(testCap - 1) + "abc" + astral,
    ];

    for (const stdout of testCases) {
      const expected = oldCapHeadCombined(stdout, "", testCap);
      const actual = capHeadCombined(stdout, "");
      expect(actual.stdout).toBe(expected.stdout);
      expect(actual.stdoutTruncated).toBe(expected.stdoutTruncated);
    }
  });
});
