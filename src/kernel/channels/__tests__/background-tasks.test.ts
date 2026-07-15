import { describe, expect, it } from "bun:test";
import {
  _resetBackgroundTaskProviderForTests,
  listBackgroundTasks,
  registerBackgroundTaskProvider,
} from "@/kernel/channels/background-tasks.ts";

describe("background task kernel channel", () => {
  it("throws a clear error before registration", () => {
    _resetBackgroundTaskProviderForTests();

    expect(() => listBackgroundTasks()).toThrow("Background task provider is not registered");
  });

  it("reads through the registered provider", () => {
    _resetBackgroundTaskProviderForTests();
    registerBackgroundTaskProvider({
      list: () => [],
      subscribe: () => () => {},
      subscribeCompletion: () => () => {},
    });

    expect(listBackgroundTasks()).toEqual([]);
  });
});
