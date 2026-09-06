import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import type { TranscriptImage } from "@/engine/session/record/types.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { Glyph } from "@/ui/theme/theme.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

const FG_24BIT = /\x1b\[38;2;\d+;\d+;\d+m/;
const BG_24BIT = /\x1b\[48;2;\d+;\d+;\d+m/;

describe("StringViewTranscript", () => {
  it("prefixes each entry with one blank row", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([
      { kind: "user", text: "oi" },
      { kind: "assistant", text: "olá" },
    ]);
    const lines = transcript.render(40);
    expect(lines[0]).toBe("");
    const secondBlank = lines.indexOf("", 1);
    expect(secondBlank).toBeGreaterThan(0);
  });

  it("paints the user message as a full-width reverse-video bar", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([{ kind: "user", text: "hello there" }]);
    const [, bar] = transcript.render(40);
    expect(stringWidth(stripAnsi(bar ?? ""))).toBe(40);
    expect(stripAnsi(bar ?? "").startsWith(Glyph.chevron)).toBe(true);
    expect(BG_24BIT.test(bar ?? "")).toBe(true);
  });

  it("wraps long user text keeping every row full width", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([{ kind: "user", text: "word ".repeat(40).trim() }]);
    const rows = transcript.render(30).filter((line) => line.length > 0);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(stringWidth(stripAnsi(row))).toBe(30);
    }
    expect(stripAnsi(rows[1] ?? "").startsWith("  ")).toBe(true);
  });

  it("renders assistant markdown behind the themed bullet gutter", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([{ kind: "assistant", text: "This is **bold** text." }]);
    const [, head] = transcript.render(60);
    expect(stripAnsi(head ?? "").startsWith(Glyph.bullet)).toBe(true);
    expect(FG_24BIT.test(head ?? "")).toBe(true);
    expect(head ?? "").toContain("\x1b[1m");
  });

  it("indents assistant continuation rows under the gutter", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([{ kind: "assistant", text: "one\n\ntwo" }]);
    const rows = transcript.render(60).filter((line) => line.length > 0);
    expect(rows.length).toBeGreaterThan(1);
    expect(stripAnsi(rows.at(-1) ?? "").startsWith("  ")).toBe(true);
  });

  it("renders identically across repeated renders at the same width", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([
      { kind: "user", text: "oi" },
      { kind: "assistant", text: "Olá! Como posso ajudar?" },
    ]);
    expect(transcript.render(50)).toEqual(transcript.render(50));
  });

  it("keeps every wrapped thinking row dim, not just the first", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([{ kind: "thinking", text: "reasoning ".repeat(20).trim() }]);
    const rows = transcript.render(30).filter((line) => line.trim().length > 0);
    expect(rows.length).toBeGreaterThan(1);
    // Every wrapped row carries the dim code; a stranded style would leave
    // continuation rows as plain text.
    for (const row of rows) expect(row).toContain("\x1b[2m");
  });

  // Collapsed reasoning is prose, so it breaks between words. Sending it through the
  // wrapper that carries raw command output instead cuts words in half at the column.
  it("wraps collapsed thinking between words", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([{ kind: "thinking", text: "deliberation ".repeat(12).trim() }]);
    const rows = transcript
      .render(30)
      .map((line) => stripAnsi(line))
      .filter((line) => line.trim().length > 0);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const words = row.replace(Glyph.therefore, "").trim().split(/\s+/);
      for (const word of words) expect(word).toBe("deliberation");
    }
  });

  // Reasoning is markdown: emphasis the model put mid-sentence is styled, not spelled
  // out in its own markers. A whole line of bold is the one exception — it is spoken
  // plainly so it cannot outshine the dimmed block it belongs to.
  it("styles the emphasis inside thinking", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([{ kind: "thinking", text: "the **first** option" }]);
    const [, row = ""] = transcript.render(60);
    expect(stripAnsi(row)).toContain("the first option");
    expect(row).toContain("\x1b[1m");
  });

  it("speaks a whole bold line in thinking plainly", () => {
    const transcript = new StringViewTranscript();
    transcript.setEntries([{ kind: "thinking", text: "**Weighing options**\n\nthe first one" }]);
    const row = transcript.render(60)[1] ?? "";
    expect(stripAnsi(row)).toContain("Weighing options");
    expect(row).not.toContain("\x1b[1m");
  });

  // The paste is written to the image cache, so its chip is the reader's way back to
  // the picture. With nothing cached there is nothing to open and it stays plain text.
  describe("a pasted image chip", () => {
    const previousForceHyperlink = process.env.FORCE_HYPERLINK;

    beforeAll(() => {
      process.env.FORCE_HYPERLINK = "1";
    });

    afterAll(() => {
      if (previousForceHyperlink === undefined) delete process.env.FORCE_HYPERLINK;
      else process.env.FORCE_HYPERLINK = previousForceHyperlink;
    });

    function chipRow(image: TranscriptImage): string {
      const transcript = new StringViewTranscript();
      transcript.setEntries([{ kind: "user", text: "olha isto", images: [image] }]);
      return transcript.render(60).find((line) => stripAnsi(line).includes("[Image #1]")) ?? "";
    }

    it("opens the cached file", () => {
      const row = chipRow({ id: 1, mediaType: "image/png", localPath: "/cache/1.png" });
      expect(row).toContain("file:///cache/1.png");
      expect(stripAnsi(row)).toContain("[Image #1]");
    });

    it("stays plain when the paste was never cached", () => {
      const row = chipRow({ id: 1, mediaType: "image/png" });
      expect(row).not.toContain("file://");
      expect(stripAnsi(row)).toContain("[Image #1]");
    });
  });
});
