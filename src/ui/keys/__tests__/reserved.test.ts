import { describe, expect, test } from "bun:test";
import { DEFAULT_BINDINGS } from "@/ui/keys/defaults.ts";
import { isReservedKey, reservedKeyFor } from "@/ui/keys/reserved.ts";

describe("reserved keys", () => {
  test("the ways out of a turn and the session cannot be rebound", () => {
    for (const chord of ["ctrl+c", "ctrl+d", "ctrl+m"]) {
      expect(`${chord}:${reservedKeyFor(chord)?.severity}`).toBe(`${chord}:error`);
    }
  });

  test("suspend warns while quit refuses", () => {
    expect(reservedKeyFor("ctrl+z")?.severity).toBe("warning");
    expect(reservedKeyFor("ctrl+\\")?.severity).toBe("error");
  });

  test("the platform shortcuts refuse", () => {
    for (const chord of ["cmd+c", "cmd+v", "cmd+x", "cmd+q", "cmd+w", "cmd+tab", "cmd+space"]) {
      expect(`${chord}:${reservedKeyFor(chord)?.severity}`).toBe(`${chord}:error`);
    }
  });

  test("ctrl+s and ctrl+q stay ours — flow control is off in a modern terminal", () => {
    expect(isReservedKey("ctrl+s")).toBe(false);
    expect(isReservedKey("ctrl+q")).toBe(false);
  });

  test("a chord is judged by its first step, whatever spelling it arrives in", () => {
    expect(reservedKeyFor("Control+C")?.severity).toBe("error");
    expect(reservedKeyFor("command+Q")?.severity).toBe("error");
    expect(isReservedKey("ctrl+c ctrl+e")).toBe(true);
    expect(isReservedKey("ctrl+x ctrl+c")).toBe(false);
  });

  test("an unreadable chord reserves nothing", () => {
    expect(reservedKeyFor("")).toBeNull();
  });
});

describe("the defaults respect the reserved set", () => {
  /**
   * A default may USE a refused key — that is how the session stays reachable —
   * so this pins the exact set we ship. Two of these are the reserved key doing
   * its own job (`ctrl+c` cancels), one is the readline meaning `ctrl+d` has had
   * for decades, and `transcript/ctrl+d` is the pager's half-page scroll. Adding
   * to this list is a decision, not an accident; the test is here to force it.
   */
  test("the defaults bind a refused key only where they are pinned to", () => {
    const offenders: string[] = [];
    for (const [context, bindings] of Object.entries(DEFAULT_BINDINGS)) {
      for (const chord of Object.keys(bindings)) {
        if (reservedKeyFor(chord)?.severity === "error") offenders.push(`${context}/${chord}`);
      }
    }
    expect(offenders.sort()).toEqual([
      "app/ctrl+c",
      "edit/ctrl+d",
      "historySearch/ctrl+c",
      "prompt/ctrl+c",
      "transcript/ctrl+c",
      "transcript/ctrl+d",
    ]);
  });
});
