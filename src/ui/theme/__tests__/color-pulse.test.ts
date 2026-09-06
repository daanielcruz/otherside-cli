import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { PULSE_FRAME_MS, pulsedColor } from "@/ui/theme/color-pulse.ts";

const BASE = "#b1b9f9";
const CYCLE_MS = PULSE_FRAME_MS * 20;
const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

function frameAt(atMs: number): string {
  return String(pulsedColor(BASE, atMs));
}

describe("pulsedColor", () => {
  it("starts a cycle on the base colour and dips darkest at its midpoint", () => {
    const dimmest = frameAt(10 * PULSE_FRAME_MS);
    expect(frameAt(0)).toBe(BASE);
    expect(dimmest).not.toBe(BASE);

    // The dim frame sits below the base without falling past the depth of the dip.
    const dim = Number.parseInt(dimmest.slice(1, 3), 16);
    const base = Number.parseInt(BASE.slice(1, 3), 16);
    expect(dim).toBeLessThan(base);
    expect(dim).toBeGreaterThanOrEqual(Math.round(base * 0.82));
  });

  it("repeats every cycle and moves symmetrically around the midpoint", () => {
    expect(frameAt(CYCLE_MS)).toBe(frameAt(0));
    expect(frameAt(CYCLE_MS + 3 * PULSE_FRAME_MS)).toBe(frameAt(3 * PULSE_FRAME_MS));
    expect(frameAt(3 * PULSE_FRAME_MS)).toBe(frameAt(17 * PULSE_FRAME_MS));
    expect(frameAt(9 * PULSE_FRAME_MS)).toBe(frameAt(11 * PULSE_FRAME_MS));
  });

  it("keeps the flat colour when the terminal cannot render the steps apart", () => {
    chalk.level = 2;
    expect(frameAt(10 * PULSE_FRAME_MS)).toBe(BASE);
    chalk.level = 3;
  });

  it("passes through a colour it cannot interpolate", () => {
    expect(String(pulsedColor("ansi:blue", 10 * PULSE_FRAME_MS))).toBe("ansi:blue");
  });
});
