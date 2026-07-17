import { describe, expect, it } from "bun:test";
import { createPromptHistoryNav } from "@/ui/app/drain/prompt-history-nav.ts";

function makeNav(history: string[]) {
  const historyRef = { current: [...history] };
  const indexRef: { current: number | null } = { current: null };
  const nav = createPromptHistoryNav({ historyRef, indexRef, sessionId: "test-session" });
  return { nav, historyRef, indexRef };
}

describe("createPromptHistoryNav", () => {
  describe("restorePrev", () => {
    it("returns null on empty history", () => {
      const { nav } = makeNav([]);
      expect(nav.restorePrev("")).toBeNull();
    });

    it("starts at the most recent entry", () => {
      const { nav } = makeNav(["a", "b", "c"]);
      expect(nav.restorePrev("")).toEqual({ value: "c", offset: 1, total: 3 });
    });

    it("walks backward through history oldest-ward", () => {
      const { nav } = makeNav(["a", "b", "c"]);
      nav.restorePrev("");
      expect(nav.restorePrev("c")).toEqual({ value: "b", offset: 2, total: 3 });
      expect(nav.restorePrev("b")).toEqual({ value: "a", offset: 3, total: 3 });
    });

    it("clamps at the oldest entry", () => {
      const { nav } = makeNav(["a", "b"]);
      nav.restorePrev("");
      nav.restorePrev("b");
      expect(nav.restorePrev("a")).toEqual({ value: "a", offset: 2, total: 2 });
    });
  });

  describe("restoreNext", () => {
    it("returns null when no navigation has started", () => {
      const { nav } = makeNav(["a", "b"]);
      expect(nav.restoreNext("")).toBeNull();
    });

    it("walks forward then clears to an empty draft past the newest", () => {
      const { nav } = makeNav(["a", "b"]);
      nav.restorePrev("");
      nav.restorePrev("b");
      expect(nav.restoreNext("a")).toEqual({ value: "b", offset: 1, total: 2 });
      expect(nav.restoreNext("b")).toEqual({ value: "", offset: 0, total: 2 });
    });
  });

  describe("exit-scrub on edit", () => {
    it("restarts traversal from the newest entry when the buffer was edited", () => {
      const { nav, indexRef } = makeNav(["a", "b", "c"]);
      nav.restorePrev("");
      nav.restorePrev("c");
      expect(indexRef.current).toBe(1);
      // The recalled "b" was edited to "bX": the next Up ignores the stale
      // index and starts a fresh run from the most recent entry.
      expect(nav.restorePrev("bX")).toEqual({ value: "c", offset: 1, total: 3 });
      expect(indexRef.current).toBe(2);
    });

    it("keeps walking when the buffer still matches the last restored value", () => {
      const { nav } = makeNav(["a", "b", "c"]);
      nav.restorePrev("");
      expect(nav.restorePrev("c")).toEqual({ value: "b", offset: 2, total: 3 });
    });
  });

  describe("push", () => {
    it("ignores blank entries (early-return, no FS write)", () => {
      const { nav, historyRef } = makeNav(["a"]);
      nav.push("   ");
      expect(historyRef.current).toEqual(["a"]);
    });
  });

  describe("bash-mode filtering", () => {
    it("narrows traversal to `!`-prefixed entries when the buffer is in bash mode", () => {
      const { nav } = makeNav(["plain one", "!ls", "plain two", "!pwd"]);
      expect(nav.restorePrev("!")).toEqual({ value: "!pwd", offset: 1, total: 2 });
      expect(nav.restorePrev("!pwd")).toEqual({ value: "!ls", offset: 2, total: 2 });
      expect(nav.restorePrev("!ls")).toEqual({ value: "!ls", offset: 2, total: 2 });
    });

    it("starts from the full history in prompt mode", () => {
      const { nav } = makeNav(["plain", "!ls"]);
      expect(nav.restorePrev("")).toEqual({ value: "!ls", offset: 1, total: 2 });
    });

    it("restarts the run over the bash view after recalling a bash entry", () => {
      const { nav } = makeNav(["plain", "!ls"]);
      // Recalling "!ls" from prompt mode puts the prompt in bash mode; the
      // next Up traverses the bash view only (exit the mode to reach "plain").
      expect(nav.restorePrev("")).toEqual({ value: "!ls", offset: 1, total: 2 });
      expect(nav.restorePrev("!ls")).toEqual({ value: "!ls", offset: 1, total: 1 });
    });

    it("returns null in bash mode when no bash entries exist", () => {
      const { nav } = makeNav(["plain one", "plain two"]);
      expect(nav.restorePrev("!")).toBeNull();
    });
  });
});
