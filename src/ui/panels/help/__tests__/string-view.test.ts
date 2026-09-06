import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { createHelpPanel } from "@/ui/panels/help/string-view.ts";

const WIDTH = 100;

function helpText(): string {
  return createHelpPanel(() => {})
    .render(WIDTH)
    .map(stripAnsi)
    .join("\n");
}

describe("help shortcuts", () => {
  it("promises no transcript scrolling the chat does not answer", () => {
    const text = helpText();
    expect(text).not.toContain("PgUp");
    expect(text).not.toContain("PgDn");
    expect(text).not.toContain("Ctrl+Home");
  });

  it("names the reader the scroll keys actually live in", () => {
    const text = helpText();
    expect(text).toContain("Ctrl+O");
    expect(text).toContain("Full-screen transcript (Ctrl+O)");
    expect(text).toContain("half page");
  });

  it("names the key that pastes deleted text back", () => {
    expect(helpText()).toContain("Ctrl+Y         paste deleted text");
  });
});
