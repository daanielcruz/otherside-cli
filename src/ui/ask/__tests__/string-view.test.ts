import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { askGroup, clear, type GroupQuestion } from "@/kernel/channels/ask.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { StringViewAskPrompt } from "@/ui/ask/string-view.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

const key = (name: string | undefined, sequence?: string): KeyEventData => ({
  kind: "key",
  fn: false,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence,
  raw: sequence,
  isPasted: false,
});

const question = (overrides: Partial<GroupQuestion> = {}): GroupQuestion => ({
  question: "Choose one?",
  header: "Choice",
  options: [
    { label: "Alpha", description: "First" },
    { label: "Beta", description: "Second", preview: "Beta preview" },
  ],
  multiSelect: false,
  allowFreeform: false,
  allowChat: false,
  ...overrides,
});

function mountPanel(): { panel: StringViewAskPrompt; focused: unknown[]; renders: () => number } {
  const panel = new StringViewAskPrompt();
  const focused: unknown[] = [];
  let renderCount = 0;
  panel.mount({
    requestRender: () => renderCount++,
    pushFocus: (target) => focused.push(target),
    popFocus: (target) => {
      const index = focused.lastIndexOf(target);
      if (index >= 0) focused.splice(index, 1);
    },
  });
  return { panel, focused, renders: () => renderCount };
}

afterEach(() => clear());

describe("StringViewAskPrompt", () => {
  test("renders and resolves a single selected option", async () => {
    const { panel, focused, renders } = mountPanel();
    const result = askGroup([question()]);

    const output = stripAnsi(panel.render(80).join("\n"));
    expect(output).toContain("Choose one?");
    expect(output).toContain("1. Alpha");
    expect(output).toContain("2. Beta");
    expect(focused).toEqual([panel]);

    panel.handleKey(key("down"));
    expect(stripAnsi(panel.render(80).join("\n"))).toContain("Beta preview");
    panel.handleKey(key("return"));

    expect(await result).toEqual({
      declined: false,
      answers: [{ question: "Choose one?", answer: "Beta" }],
    });
    expect(focused).toEqual([]);
    expect(renders()).toBeGreaterThan(1);
    panel.unmount();
  });

  test("wraps a long question without hiding any decision text", async () => {
    const { panel } = mountPanel();
    const longQuestion =
      "Before we continue, please choose the deployment strategy that best balances release speed, operational safety, rollback simplicity, and the needs of every team that depends on this service.";
    const result = askGroup([question({ question: longQuestion })]);

    const lines = panel.render(52).map(stripAnsi);
    const questionStart = lines.findIndex((line) => line.includes("Before we continue"));
    const optionsStart = lines.findIndex((line) => line.includes("1. Alpha"));
    const questionLines = lines.slice(questionStart, optionsStart).filter((line) => line.trim());

    expect(questionStart).toBeGreaterThan(-1);
    expect(optionsStart).toBeGreaterThan(questionStart);
    expect(questionLines.length).toBeGreaterThan(1);
    expect(questionLines.join(" ").replace(/\s+/g, " ").trim()).toBe(longQuestion);
    expect(questionLines.join("\n")).not.toContain("…");

    panel.handleKey(key("return"));
    await result;
    panel.unmount();
  });

  test("collects multi-select answers and submits the review tab", async () => {
    const { panel } = mountPanel();
    const result = askGroup([
      question({ question: "First?", multiSelect: true }),
      question({ question: "Second?" }),
    ]);

    panel.handleKey(key(undefined, " "));
    panel.handleKey(key("return"));
    panel.handleKey(key("down"));
    panel.handleKey(key("return"));
    expect(stripAnsi(panel.render(80).join("\n"))).toContain("Review your answers");
    panel.handleKey(key("return"));

    expect(await result).toEqual({
      declined: false,
      answers: [
        { question: "First?", answer: "Alpha" },
        { question: "Second?", answer: "Beta" },
      ],
    });
    panel.unmount();
  });

  test("wraps a long freeform answer and keeps the caret visible", async () => {
    const { panel } = mountPanel();
    const result = askGroup([question({ options: [], allowFreeform: true, question: "Explain?" })]);
    const longAnswer =
      "Use a staged rollout beginning with internal users, then expand gradually while measuring errors and keeping rollback visible.";

    panel.handleKey(key(undefined, longAnswer));
    const rendered = panel.render(42);
    const lines = rendered.map(stripAnsi);
    const answerStart = lines.findIndex((line) => line.includes("Use a staged rollout"));
    const answerEnd = lines.findIndex((line) => line.includes("rollback visible."));
    const answerLines = lines.slice(answerStart, answerEnd + 1);

    expect(answerStart).toBeGreaterThan(-1);
    expect(answerEnd).toBeGreaterThan(answerStart);
    expect(answerLines.join(" ").replace(/\s+/g, " ").trim()).toContain(longAnswer);
    expect(rendered[answerEnd]).toContain("\x1b[7m");

    panel.handleKey(key("return"));
    expect(await result).toEqual({
      declined: false,
      answers: [{ question: "Explain?", answer: longAnswer }],
    });
    panel.unmount();
  });

  test("accepts freeform text and cancels with Escape", async () => {
    const first = mountPanel();
    const freeform = askGroup([
      question({ options: [], allowFreeform: true, question: "Explain?" }),
    ]);
    first.panel.handleKey(key(undefined, "h"));
    first.panel.handleKey(key(undefined, "i"));
    first.panel.handleKey(key("return"));
    expect(await freeform).toEqual({
      declined: false,
      answers: [{ question: "Explain?", answer: "hi" }],
    });
    first.panel.unmount();

    const second = mountPanel();
    const declined = askGroup([question()]);
    second.panel.handleKey(key("escape"));
    expect(await declined).toEqual({ declined: true, reason: "cancel" });
    second.panel.unmount();
  });

  test("steps through the questions from the left edge with arrows around flush chips", () => {
    const { panel } = mountPanel();
    void askGroup([question({ header: "Color" }), question({ header: "Size" })]);

    const lines = panel.render(100).map(stripAnsi);

    expect(lines[1]).toBe(`${Glyph.arrowLeft}  ☐ Color  ☐ Size  ✔ Submit  ${Glyph.arrowRight}`);
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("Choose one?");
    panel.unmount();
  });

  test("dims the arrow at the end the steps cannot move past", () => {
    const { panel } = mountPanel();
    void askGroup([question({ header: "Color" }), question({ header: "Size" })]);
    const dimmed = (arrow: string) => renderTextWithStyles(arrow, { color: Color.muted });

    expect(panel.render(100)[1]?.startsWith(dimmed(`${Glyph.arrowLeft} `))).toBe(true);
    panel.handleKey(key("right"));
    panel.handleKey(key("right"));
    expect(panel.render(100)[1]?.endsWith(dimmed(` ${Glyph.arrowRight}`))).toBe(true);
    panel.unmount();
  });

  test("stops at the first and the last step instead of wrapping around", () => {
    const { panel } = mountPanel();
    void askGroup([question(), question({ question: "Second?" })]);
    const screen = () => stripAnsi(panel.render(100).join("\n"));

    panel.handleKey(key("left"));
    expect(screen()).toContain("Choose one?");
    expect(screen()).not.toContain("Review your answers");

    panel.handleKey(key("right"));
    panel.handleKey(key("right"));
    panel.handleKey(key("right"));
    expect(screen()).toContain("Review your answers");
    panel.unmount();
  });

  test("moves the free-text caret with the arrows instead of stepping to another question", () => {
    const { panel } = mountPanel();
    void askGroup([
      question({ options: [], allowFreeform: true, question: "First?" }),
      question({ question: "Second?" }),
    ]);
    const screen = () => stripAnsi(panel.render(100).join("\n"));

    panel.handleKey(key(undefined, "ac"));
    panel.handleKey(key("left"));
    panel.handleKey(key(undefined, "b"));
    panel.handleKey(key("right"));
    panel.handleKey(key("tab", "\t"));

    expect(screen()).toContain("First?");
    expect(screen()).toContain("abc");
    panel.unmount();
  });

  test("sets the key hints upright", () => {
    const { panel } = mountPanel();
    void askGroup([question()]);
    const hintRow = panel.render(100).find((line) => stripAnsi(line).includes("Esc to cancel"));

    expect(hintRow).toBeDefined();
    expect(hintRow).not.toContain("\x1b[3m");
    panel.unmount();
  });

  test("shows a lone question's chip without arrows", () => {
    const { panel } = mountPanel();
    void askGroup([question({ header: "Color" })]);

    expect(stripAnsi(panel.render(100)[1] ?? "")).toBe(" ☐ Color ");
    panel.unmount();
  });

  test("spells out every key hint under a question", () => {
    const single = mountPanel();
    void askGroup([question()]);
    expect(stripAnsi(single.panel.render(100).join("\n"))).toContain(
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    );
    single.panel.unmount();
    clear();

    const several = mountPanel();
    void askGroup([question(), question({ question: "Second?" })]);
    expect(stripAnsi(several.panel.render(100).join("\n"))).toContain(
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    );
    several.panel.unmount();
  });

  test("reviews the answers under their own heading before asking to submit", () => {
    const { panel } = mountPanel();
    void askGroup([question({ header: "Color" }), question({ header: "Size", question: "Size?" })]);
    panel.handleKey(key("return"));
    panel.handleKey(key("down"));
    panel.handleKey(key("return"));

    const lines = panel.render(100).map(stripAnsi);

    expect(lines.slice(1)).toEqual([
      `${Glyph.arrowLeft}  ☒ Color  ☒ Size  ✔ Submit  ${Glyph.arrowRight}`,
      "",
      "Review your answers",
      "",
      " ● Choose one?",
      "   → Alpha",
      " ● Size?",
      "   → Beta",
      "",
      "Ready to submit your answers?",
      "",
      "❯ 1. Submit answers",
      "  2. Cancel",
      "",
    ]);
    panel.unmount();
  });

  test("leaves unanswered questions out of the review", () => {
    const { panel } = mountPanel();
    void askGroup([question(), question({ question: "Skipped?" })]);
    panel.handleKey(key("return"));
    panel.handleKey(key("right"));

    const output = stripAnsi(panel.render(100).join("\n"));

    expect(output).toContain("You have not answered all questions");
    expect(output).not.toContain("Skipped?");
    panel.unmount();
  });

  test("cancels the whole ask from the review's Cancel choice", async () => {
    const { panel } = mountPanel();
    const result = askGroup([question(), question({ question: "Second?" })]);
    panel.handleKey(key("return"));
    panel.handleKey(key("return"));
    panel.handleKey(key("down"));
    panel.handleKey(key("return"));

    expect(await result).toEqual({ declined: true, reason: "cancel" });
    panel.unmount();
  });
});
