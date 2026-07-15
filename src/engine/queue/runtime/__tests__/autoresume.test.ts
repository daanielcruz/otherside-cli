import { describe, expect, it, mock } from "bun:test";
import {
  AUTORESUME_DELAY_MS,
  createAutoresumeScheduler,
} from "@/engine/queue/runtime/autoresume.ts";

interface MockGuards {
  pending: boolean;
  running: boolean;
  blocked: boolean;
}

function mockGuards(initial: Partial<MockGuards> = {}): {
  guards: MockGuards;
  api: {
    isPending: () => boolean;
    isRunning: () => boolean;
    isBlocked: () => boolean;
  };
} {
  const guards: MockGuards = {
    pending: initial.pending ?? true,
    running: initial.running ?? false,
    blocked: initial.blocked ?? false,
  };
  return {
    guards,
    api: {
      isPending: () => guards.pending,
      isRunning: () => guards.running,
      isBlocked: () => guards.blocked,
    },
  };
}

describe("createAutoresumeScheduler", () => {
  it("fires onFire after delay when all guards pass", () => {
    const { api } = mockGuards();
    const onFire = mock(() => {});
    const clearPending = mock(() => {});
    const scheduler = createAutoresumeScheduler({
      guards: api,
      onFire,
      clearPending,
      delayMs: 10,
    });
    scheduler.arm();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onFire).toHaveBeenCalledTimes(1);
        expect(clearPending).toHaveBeenCalledTimes(1);
        resolve();
      }, 30);
    });
  });

  it("skips onFire when isPending returns false", () => {
    const { guards, api } = mockGuards({ pending: false });
    const onFire = mock(() => {});
    const clearPending = mock(() => {});
    const scheduler = createAutoresumeScheduler({
      guards: api,
      onFire,
      clearPending,
      delayMs: 10,
    });
    scheduler.arm();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onFire).toHaveBeenCalledTimes(0);
        expect(clearPending).toHaveBeenCalledTimes(0);
        expect(guards.pending).toBe(false);
        resolve();
      }, 30);
    });
  });

  it("skips onFire when isRunning returns true", () => {
    const { api } = mockGuards({ running: true });
    const onFire = mock(() => {});
    const clearPending = mock(() => {});
    const scheduler = createAutoresumeScheduler({
      guards: api,
      onFire,
      clearPending,
      delayMs: 10,
    });
    scheduler.arm();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onFire).toHaveBeenCalledTimes(0);
        expect(clearPending).toHaveBeenCalledTimes(0);
        resolve();
      }, 30);
    });
  });

  it("skips onFire when isBlocked returns true", () => {
    const { api } = mockGuards({ blocked: true });
    const onFire = mock(() => {});
    const clearPending = mock(() => {});
    const scheduler = createAutoresumeScheduler({
      guards: api,
      onFire,
      clearPending,
      delayMs: 10,
    });
    scheduler.arm();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onFire).toHaveBeenCalledTimes(0);
        resolve();
      }, 30);
    });
  });

  it("clear() cancels pending fire", () => {
    const { api } = mockGuards();
    const onFire = mock(() => {});
    const clearPending = mock(() => {});
    const scheduler = createAutoresumeScheduler({
      guards: api,
      onFire,
      clearPending,
      delayMs: 10,
    });
    scheduler.arm();
    scheduler.clear();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onFire).toHaveBeenCalledTimes(0);
        resolve();
      }, 30);
    });
  });

  it("re-arm replaces the pending timer (latest wins)", () => {
    const { api } = mockGuards();
    const onFire = mock(() => {});
    const clearPending = mock(() => {});
    const scheduler = createAutoresumeScheduler({
      guards: api,
      onFire,
      clearPending,
      delayMs: 20,
    });
    scheduler.arm();
    scheduler.arm();
    scheduler.arm();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onFire).toHaveBeenCalledTimes(1);
        resolve();
      }, 50);
    });
  });

  it("dispose() is equivalent to clear()", () => {
    const { api } = mockGuards();
    const onFire = mock(() => {});
    const clearPending = mock(() => {});
    const scheduler = createAutoresumeScheduler({
      guards: api,
      onFire,
      clearPending,
      delayMs: 10,
    });
    scheduler.arm();
    scheduler.dispose();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onFire).toHaveBeenCalledTimes(0);
        resolve();
      }, 30);
    });
  });

  it("default delay matches AUTORESUME_DELAY_MS (50)", () => {
    expect(AUTORESUME_DELAY_MS).toBe(50);
  });

  it("guards evaluated at fire time, not arm time", () => {
    const { guards, api } = mockGuards({ pending: true, running: false });
    const onFire = mock(() => {});
    const clearPending = mock(() => {});
    const scheduler = createAutoresumeScheduler({
      guards: api,
      onFire,
      clearPending,
      delayMs: 10,
    });
    scheduler.arm();
    guards.running = true;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onFire).toHaveBeenCalledTimes(0);
        resolve();
      }, 30);
    });
  });
});
