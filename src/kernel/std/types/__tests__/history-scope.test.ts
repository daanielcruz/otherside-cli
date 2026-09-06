import { describe, expect, test } from "bun:test";
import {
  HISTORY_SCOPES,
  type HistoryScope,
  nextHistoryScope,
} from "@/kernel/std/types/history-scope.ts";

describe("how wide the search looks", () => {
  test("offers this session, this project, and every project", () => {
    expect([...HISTORY_SCOPES]).toEqual(["session", "project", "everywhere"]);
  });

  test("cycles and wraps, because there is no end to walk off", () => {
    expect(nextHistoryScope("session")).toBe("project");
    expect(nextHistoryScope("project")).toBe("everywhere");
    expect(nextHistoryScope("everywhere")).toBe("session");
  });

  test("comes back to where it started after one round", () => {
    let scope: HistoryScope = "session";
    for (let step = 0; step < HISTORY_SCOPES.length; step++) scope = nextHistoryScope(scope);
    expect(scope).toBe("session");
  });
});
