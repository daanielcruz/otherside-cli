import { afterEach, describe, expect, test } from "bun:test";
import {
  armStopConfirm,
  clearStopConfirm,
  setStopConfirmHoldForTests,
  stopConfirmStore,
} from "@/store/stop-confirm/index.ts";

afterEach(() => {
  setStopConfirmHoldForTests(3_000);
  clearStopConfirm();
});

describe("stop-confirm store", () => {
  test("arming records the row and whether the press stopped a live run", () => {
    armStopConfirm("task-1", true);
    expect(stopConfirmStore.getState()).toEqual({ taskId: "task-1", justStopped: true });
  });

  test("re-arming another row replaces the armed one", () => {
    armStopConfirm("task-1", true);
    armStopConfirm("task-2", false);
    expect(stopConfirmStore.getState()).toEqual({ taskId: "task-2", justStopped: false });
  });

  test("clearing disarms", () => {
    armStopConfirm("task-1", false);
    clearStopConfirm();
    expect(stopConfirmStore.getState().taskId).toBeNull();
  });

  test("the hold expiring disarms on its own", async () => {
    setStopConfirmHoldForTests(10);
    armStopConfirm("task-1", true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopConfirmStore.getState().taskId).toBeNull();
  });

  test("a clear after the hold leaves no stray timer re-clearing a later arm", async () => {
    setStopConfirmHoldForTests(10);
    armStopConfirm("task-1", true);
    clearStopConfirm();
    setStopConfirmHoldForTests(3_000);
    armStopConfirm("task-2", false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopConfirmStore.getState().taskId).toBe("task-2");
  });
});
