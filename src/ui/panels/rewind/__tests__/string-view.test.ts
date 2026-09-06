import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { formatHint, HINT_JOINER, hintFor } from "@/ui/chrome/panel-hints.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { renderRewindOptionLines } from "../option-rows.ts";
import type { RewindTurn, RewindUserTurn } from "../options.ts";
import { createRewindPanel } from "../string-view.ts";

/** Rows the string-view shell (prompt frame, status rows) keeps beneath a panel. */
const SHELL_ROWS = 7;
const WIDTH = 80;

function fixtureTurns(count: number): RewindUserTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    text: `Checkpoint message ${index}`,
  }));
}

function mountedPanel(turnCount: number, terminalRows: () => number): StringViewPanel {
  const panel = createRewindPanel(() => {}, { sessionId: "", userTurns: fixtureTurns(turnCount) });
  panel.mount?.({ requestRender() {}, pushFocus() {}, popFocus() {}, terminalRows });
  return panel;
}

function keyEvent(name: string, flags: Partial<KeyEventData> = {}): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: "",
    raw: "",
    isPasted: false,
    ...flags,
  };
}

describe("rewind picker layout", () => {
  it("clips a turn title to the terminal width and keeps metadata on its own row", () => {
    const turn: RewindTurn = {
      kind: "turn",
      id: "turn",
      preview: "Checkpoint ".repeat(20).trim(),
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };
    const lines = renderRewindOptionLines(turn, true, 72).map(stripAnsi);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith("❯ Checkpoint");
    expect(lines[0]).toEndWith("…");
    expect(lines[0]!.length).toBe(64);
    expect(lines[1]).toBe("  No code changes");
    expect(lines[2]).toBe("");
  });

  it("reserves two blank rows beneath the current sentinel", () => {
    expect(
      renderRewindOptionLines({ kind: "current", id: "__current" }, true, 72).map(stripAnsi),
    ).toEqual(["❯ (current)", "", ""]);
  });
});

describe("rewind panel height budget", () => {
  it("stays within the body budget of a short terminal", () => {
    const lines = mountedPanel(30, () => 20).render(WIDTH);

    expect(lines.length).toBeLessThanOrEqual(20 - SHELL_ROWS);
  });

  it("caps its window in a tall terminal instead of filling the screen", () => {
    const tall = mountedPanel(30, () => 60).render(WIDTH);
    const taller = mountedPanel(30, () => 100).render(WIDTH);

    expect(tall.length).toBeLessThanOrEqual(60 - SHELL_ROWS);
    // The compact cap, not the terminal height, bounds the panel once it is tall.
    expect(taller.length).toBe(tall.length);
  });

  it("marks hidden options with counted overflow markers from the window policy", () => {
    const panel = mountedPanel(30, () => 24);
    const initial = panel.render(WIDTH).map(stripAnsi);
    // The cursor opens on the "(current)" sentinel at the bottom of the list.
    expect(initial.some((line) => /↑ \d+ more above$/.test(line.trim()))).toBe(true);

    panel.handleKey(keyEvent("up", { ctrl: true }));
    const atTop = panel.render(WIDTH).map(stripAnsi);
    expect(atTop.some((line) => /↓ \d+ more below$/.test(line.trim()))).toBe(true);
  });

  it("phrases its footer hints through the shared hint dictionary", () => {
    const lines = mountedPanel(3, () => 40)
      .render(WIDTH)
      .map(stripAnsi);
    const expected = [hintFor("enterContinue"), hintFor("cancel")]
      .map(formatHint)
      .join(HINT_JOINER);

    expect(lines.some((line) => line.includes(expected))).toBe(true);
  });
});
