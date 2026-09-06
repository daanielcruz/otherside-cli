import { afterEach, describe, expect, it } from "bun:test";
import {
  currentTerminalHandoff,
  publishTerminalHandoff,
  withReleasedTerminal,
} from "@/terminal-runtime/host/terminal-handoff.ts";

afterEach(() => {
  publishTerminalHandoff(null);
});

describe("withReleasedTerminal", () => {
  it("releases around the borrow and reclaims after it", () => {
    const log: string[] = [];
    publishTerminalHandoff({
      release: () => log.push("release"),
      reclaim: () => log.push("reclaim"),
    });

    const result = withReleasedTerminal(() => {
      log.push("borrow");
      return "done";
    });

    expect(result).toBe("done");
    expect(log).toEqual(["release", "borrow", "reclaim"]);
  });

  it("reclaims even when the borrow throws", () => {
    const log: string[] = [];
    publishTerminalHandoff({
      release: () => log.push("release"),
      reclaim: () => log.push("reclaim"),
    });

    expect(() =>
      withReleasedTerminal(() => {
        throw new Error("editor exploded");
      }),
    ).toThrow("editor exploded");
    expect(log).toEqual(["release", "reclaim"]);
  });

  it("runs the borrow plainly when no host owns the terminal", () => {
    expect(currentTerminalHandoff()).toBeNull();

    expect(withReleasedTerminal(() => 42)).toBe(42);
  });
});
