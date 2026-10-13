import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { formatClockTime } from "@/kernel/std/text/clock-time.ts";

describe("formatClockTime", () => {
  const NOW = new Date(2026, 8, 24, 13, 58);
  const priorLocale = process.env.LC_ALL;
  beforeAll(() => {
    process.env.LC_ALL = "en_US.UTF-8";
  });
  afterAll(() => {
    if (priorLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = priorLocale;
  });

  it("names the clock time for a moment today", () => {
    expect(formatClockTime(new Date(2026, 8, 24, 13, 58), NOW)).toMatch(/1:58\sPM/);
  });

  it("adds the weekday within the last week and the date beyond it", () => {
    expect(formatClockTime(new Date(2026, 8, 22, 9, 5), NOW)).toMatch(/Tuesday.*9:05/);
    expect(formatClockTime(new Date(2026, 8, 1, 9, 5), NOW)).toMatch(/Tuesday.*Sep.*1.*9:05/);
  });
});
