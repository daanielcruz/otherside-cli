import { describe, expect, it } from "bun:test";
import {
  didExternalScreenClear,
  EXTERNAL_CLEAR_QUERY_TIMEOUT_MS,
  ExternalClearWatcher,
} from "@/terminal-runtime/host/external-clear-watcher.ts";

describe("didExternalScreenClear", () => {
  it("only detects a top-row report when the expected cursor is lower", () => {
    expect(didExternalScreenClear(null, 1)).toBe(false);
    expect(didExternalScreenClear(0, 1)).toBe(false);
    expect(didExternalScreenClear(1, 1)).toBe(true);
    expect(didExternalScreenClear(4, 1)).toBe(true);
    expect(didExternalScreenClear(4, 2)).toBe(false);
    expect(didExternalScreenClear(4, undefined)).toBe(false);
  });
});

describe("ExternalClearWatcher", () => {
  it("skips the probe when the cursor is already at the top row", async () => {
    let probes = 0;
    const watcher = createWatcher({
      expectedRow: () => 0,
      requestCursorPosition: async () => {
        probes++;
        return 1;
      },
    });

    watcher.start();
    await watcher.probe();

    expect(probes).toBe(0);
  });

  it("triggers one full redraw after detecting a cleared screen", async () => {
    let redraws = 0;
    const watcher = createWatcher({
      expectedRow: () => 3,
      requestCursorPosition: async () => 1,
      onScreenClear: () => {
        redraws++;
      },
    });

    watcher.start();
    await watcher.probe();

    expect(redraws).toBe(1);
  });

  it("treats a timed-out query as not cleared", async () => {
    let requestedTimeout: number | undefined;
    let redraws = 0;
    const watcher = createWatcher({
      expectedRow: () => 3,
      requestCursorPosition: async (timeoutMs) => {
        requestedTimeout = timeoutMs;
        return undefined;
      },
      onScreenClear: () => {
        redraws++;
      },
    });

    watcher.start();
    await watcher.probe();

    expect(requestedTimeout).toBe(EXTERNAL_CLEAR_QUERY_TIMEOUT_MS);
    expect(redraws).toBe(0);
  });

  it("does not overlap cursor-position probes", async () => {
    let resolveProbe: ((row: number | undefined) => void) | undefined;
    let probes = 0;
    const watcher = createWatcher({
      expectedRow: () => 3,
      requestCursorPosition: () => {
        probes++;
        if (probes > 1) return Promise.resolve(2);
        return new Promise((resolve) => {
          resolveProbe = resolve;
        });
      },
    });

    watcher.start();
    const firstProbe = watcher.probe();
    await Promise.resolve();
    await watcher.probe();

    expect(probes).toBe(1);

    resolveProbe?.(2);
    await firstProbe;
    await watcher.probe();

    expect(probes).toBe(2);
  });
});

function createWatcher(options: {
  expectedRow: () => number | null;
  requestCursorPosition: (timeoutMs: number) => Promise<number | undefined>;
  onScreenClear?: () => void;
}): ExternalClearWatcher {
  return new ExternalClearWatcher({
    querier: { requestCursorPosition: options.requestCursorPosition },
    getExpectedCursorRow: options.expectedRow,
    onScreenClear: options.onScreenClear ?? (() => {}),
    setInterval: () => ({}) as NodeJS.Timeout,
    clearInterval: () => {},
  });
}
