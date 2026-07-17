import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { cellAtIndex, paintToTerminal, type Screen } from "@/ink";
import { StreamingMarkdown } from "../markdown/index.tsx";

const WIDTH = 40;

function renderText(source: string): string {
  const { screen } = paintToTerminal(<StreamingMarkdown source={source} width={WIDTH} />, WIDTH);
  return screenToRows(screen).join("\n");
}

function screenToRows(screen: Screen): string[] {
  const rows: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let line = "";
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAtIndex(screen, y * screen.width + x);
      line += cell.char.length > 0 ? cell.char : " ";
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return rows;
}

describe("StreamingMarkdown hyperlinks", () => {
  it("keeps styled local image labels clickable without leaking SGR text", () => {
    const previous = process.env.FORCE_HYPERLINK;
    process.env.FORCE_HYPERLINK = "1";
    try {
      const source = "Generated: [Panda macOS app icon](~/.otherside/image-cache/panda.png)\n";
      const { screen } = paintToTerminal(
        <StreamingMarkdown source={source} width={WIDTH} />,
        WIDTH,
      );
      const text = screenToRows(screen).join("\n");
      const expectedUrl = pathToFileURL(`${homedir()}/.otherside/image-cache/panda.png`).href;
      let linkedText = "";
      for (let index = 0; index < screen.width * screen.height; index++) {
        const cell = cellAtIndex(screen, index);
        if (cell.hyperlink === expectedUrl) linkedText += cell.char;
      }

      expect(text).toContain("Generated: Panda macOS app icon");
      expect(text).not.toContain("[94m");
      expect(text).not.toContain("[39m");
      expect(linkedText).toContain("Panda macOS app icon");
    } finally {
      if (previous === undefined) delete process.env.FORCE_HYPERLINK;
      else process.env.FORCE_HYPERLINK = previous;
    }
  });
});

describe("StreamingMarkdown word-boundary tail hold", () => {
  it("renders complete words from a one-line unstable tail", () => {
    const text = renderText("alpha beta gam");

    expect(text).toContain("alpha beta");
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("holds only the trailing partial word", () => {
    const text = renderText("alpha beta gam");

    expect(text).toContain("alpha beta");
    expect(text).not.toContain("gam");
  });

  it("renders the full tail when it ends in whitespace", () => {
    expect(renderText("alpha beta ")).toContain("alpha beta");
    expect(renderText("alpha beta\n")).toContain("alpha beta");
  });

  it("keeps open table tails on the plain-text branch", () => {
    const text = renderText("| alpha |\n| betaword |");

    expect(text).toContain("betaword");
  });
});
