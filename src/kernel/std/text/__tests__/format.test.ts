import { describe, expect, test } from "bun:test";
import { formatDurationCompact } from "../format.ts";

describe("formatDurationCompact", () => {
  test("drops zero seconds after whole minutes", () => {
    expect(formatDurationCompact(1_800_000)).toBe("30m");
  });

  test("drops zero minutes and seconds after whole hours", () => {
    expect(formatDurationCompact(7_200_000)).toBe("2h");
  });

  test("keeps a nonzero unit after the leading one", () => {
    expect(formatDurationCompact(5_400_000)).toBe("1h 30m");
  });

  test("keeps a zero unit that is followed by a nonzero one", () => {
    expect(formatDurationCompact(3_605_000)).toBe("1h 0m 5s");
  });

  test("keeps a lone zero", () => {
    expect(formatDurationCompact(0)).toBe("0s");
  });
});
