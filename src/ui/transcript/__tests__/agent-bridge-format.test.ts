import { expect, test } from "bun:test";
import { formatDurationMs } from "@/ui/transcript/agent-bridge.tsx";

test("formatDurationMs keeps seconds on exact-minute boundaries", () => {
  expect(formatDurationMs(60_000)).toBe("1m 0s");
  expect(formatDurationMs(120_000)).toBe("2m 0s");
});

test("formatDurationMs shows minutes and seconds", () => {
  expect(formatDurationMs(90_000)).toBe("1m 30s");
});

test("formatDurationMs shows bare seconds under a minute", () => {
  expect(formatDurationMs(45_000)).toBe("45s");
});
