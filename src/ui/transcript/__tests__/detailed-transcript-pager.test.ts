import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { DetailedTranscriptPager } from "@/ui/transcript/detailed-transcript-pager.ts";

const ROWS = 10;
const LINES = Array.from({ length: 100 }, (_, index) => `line-${index}`);

function pagerOverLines(): DetailedTranscriptPager {
  const pager = new DetailedTranscriptPager();
  pager.setContent(LINES);
  return pager;
}

function press(pager: DetailedTranscriptPager, key: Partial<KeyEventData>): boolean {
  return pager.handleKey(
    {
      kind: "key",
      fn: false,
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      sequence: undefined,
      raw: undefined,
      isPasted: false,
      ...key,
    },
    ROWS,
  );
}

function firstVisible(pager: DetailedTranscriptPager): string {
  return pager.window(ROWS)[0] ?? "";
}

describe("DetailedTranscriptPager", () => {
  it("opens pinned to the newest rows and follows growing content", () => {
    const pager = pagerOverLines();
    expect(pager.window(ROWS)).toEqual(LINES.slice(90));

    pager.setContent([...LINES, "line-100"]);
    expect(firstVisible(pager)).toBe("line-91");
  });

  it("walks lines, half pages, and full pages", () => {
    const pager = pagerOverLines();
    press(pager, { sequence: "g" });
    expect(firstVisible(pager)).toBe("line-0");

    press(pager, { sequence: "j" });
    expect(firstVisible(pager)).toBe("line-1");
    press(pager, { name: "down" });
    expect(firstVisible(pager)).toBe("line-2");
    press(pager, { name: "up" });
    press(pager, { sequence: "k" });
    expect(firstVisible(pager)).toBe("line-0");

    press(pager, { name: "d", ctrl: true });
    expect(firstVisible(pager)).toBe("line-5");
    press(pager, { name: "u", ctrl: true });
    expect(firstVisible(pager)).toBe("line-0");

    press(pager, { name: "f", ctrl: true });
    expect(firstVisible(pager)).toBe("line-10");
    press(pager, { name: "b", ctrl: true });
    expect(firstVisible(pager)).toBe("line-0");

    press(pager, { name: "space" });
    expect(firstVisible(pager)).toBe("line-10");
    press(pager, { sequence: "b" });
    expect(firstVisible(pager)).toBe("line-0");
  });

  it("jumps to both edges and clamps at them", () => {
    const pager = pagerOverLines();
    press(pager, { sequence: "G" });
    expect(firstVisible(pager)).toBe("line-90");
    press(pager, { name: "end" });
    press(pager, { sequence: "j" });
    expect(firstVisible(pager)).toBe("line-90");

    press(pager, { name: "home" });
    expect(firstVisible(pager)).toBe("line-0");
    press(pager, { sequence: "k" });
    expect(firstVisible(pager)).toBe("line-0");
  });

  it("searches from the query box and steps matches with n and N", () => {
    const pager = pagerOverLines();
    press(pager, { sequence: "g" });

    expect(press(pager, { sequence: "/" })).toBe(true);
    expect(pager.isSearching()).toBe(true);

    for (const character of "line-4") press(pager, { sequence: character });
    expect(pager.searchQuery()).toBe("line-4");
    expect(firstVisible(pager)).toBe("line-4");

    press(pager, { name: "return" });
    expect(pager.isSearching()).toBe(false);

    press(pager, { sequence: "n" });
    expect(firstVisible(pager)).toBe("line-40");
    press(pager, { sequence: "N" });
    expect(firstVisible(pager)).toBe("line-4");
  });

  it("owns every key while the query box is open and clears it on Escape", () => {
    const pager = pagerOverLines();
    press(pager, { sequence: "/" });
    for (const character of "line-9") press(pager, { sequence: character });
    press(pager, { name: "backspace" });
    expect(pager.searchQuery()).toBe("line-");
    expect(press(pager, { sequence: "q" })).toBe(true);

    press(pager, { name: "escape" });
    expect(pager.isSearching()).toBe(false);
    expect(pager.searchQuery()).toBe("");
  });

  it("leaves the reader's own bindings alone", () => {
    const pager = pagerOverLines();
    for (const key of [
      { name: "escape", sequence: "\x1b" },
      { sequence: "q" },
      { name: "o", ctrl: true },
      { name: "e", ctrl: true },
      { name: "c", ctrl: true },
    ]) {
      expect(press(pager, key)).toBe(false);
    }
  });
});
