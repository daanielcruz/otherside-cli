import { describe, expect, it } from "bun:test";
import {
  didExternalScreenClear,
  ExternalClearWatcher,
  shouldWatchExternalClears,
} from "@/terminal-runtime/string-view/host/external-clear-watch.ts";

describe("didExternalScreenClear", () => {
  it("fires only when a deeper parked row reports back as row 1", () => {
    expect(didExternalScreenClear(5, 1)).toBe(true);
    expect(didExternalScreenClear(2, 1)).toBe(true);
    expect(didExternalScreenClear(1, 1)).toBe(false);
    expect(didExternalScreenClear(5, 5)).toBe(false);
    expect(didExternalScreenClear(5, undefined)).toBe(false);
    expect(didExternalScreenClear(null, 1)).toBe(false);
  });
});

describe("shouldWatchExternalClears", () => {
  it("watches only interactive iTerm and Apple_Terminal hosts, honoring the kill switch", () => {
    const base = { stdoutIsTTY: true, termProgram: "iTerm.app", disabled: undefined };
    expect(shouldWatchExternalClears(base)).toBe(true);
    expect(shouldWatchExternalClears({ ...base, termProgram: "Apple_Terminal" })).toBe(true);
    expect(shouldWatchExternalClears({ ...base, termProgram: "tmux" })).toBe(false);
    expect(shouldWatchExternalClears({ ...base, stdoutIsTTY: false })).toBe(false);
    expect(shouldWatchExternalClears({ ...base, disabled: "1" })).toBe(false);
  });
});

describe("ExternalClearWatcher", () => {
  function watcherWith(input: {
    expected: number | null;
    reported: number | undefined;
    onClear: () => void;
  }): { watcher: ExternalClearWatcher; ticks: () => number } {
    let tickCount = 0;
    const watcher = new ExternalClearWatcher({
      querier: { requestCursorPosition: () => Promise.resolve(input.reported) },
      getExpectedCursorRow: () => input.expected,
      onScreenClear: input.onClear,
      setIntervalFn: () => {
        tickCount += 1;
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });
    return { watcher, ticks: () => tickCount };
  }

  it("reports a wipe and skips probing while the expected row is shallow", async () => {
    let cleared = 0;
    const { watcher } = watcherWith({ expected: 8, reported: 1, onClear: () => cleared++ });
    watcher.start();
    await watcher.probe();
    expect(cleared).toBe(1);
    watcher.stop();

    let shallowProbes = 0;
    const shallow = new ExternalClearWatcher({
      querier: {
        requestCursorPosition: () => {
          shallowProbes += 1;
          return Promise.resolve(1);
        },
      },
      getExpectedCursorRow: () => 1,
      onScreenClear: () => {
        throw new Error("must not fire");
      },
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    shallow.start();
    await shallow.probe();
    expect(shallowProbes).toBe(0);
  });

  it("never overlaps probes and goes quiet after stop", async () => {
    let resolveReport: (row: number | undefined) => void = () => {};
    let probes = 0;
    let cleared = 0;
    const watcher = new ExternalClearWatcher({
      querier: {
        requestCursorPosition: () => {
          probes += 1;
          return new Promise((resolve) => {
            resolveReport = resolve;
          });
        },
      },
      getExpectedCursorRow: () => 9,
      onScreenClear: () => cleared++,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    watcher.start();
    const first = watcher.probe();
    await watcher.probe();
    expect(probes).toBe(1);
    watcher.stop();
    resolveReport(1);
    await first;
    // A reply that lands after stop must not trigger recovery.
    expect(cleared).toBe(0);
  });
});
