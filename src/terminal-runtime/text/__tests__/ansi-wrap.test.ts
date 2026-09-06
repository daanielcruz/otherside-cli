import { describe, expect, it } from "bun:test";
import { osc8FileLink } from "@/terminal-runtime/terminal/hyperlink-sequences.js";
import { wrapAnsi, wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";

const OSC8_SEQUENCE_RE = /\x1b]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC8_CLOSE_RE = /^\x1b]8;;(?:\x07|\x1b\\)$/;

describe("wrapAnsi", () => {
  it("wraps every row of a file link in a complete hyperlink", () => {
    const path = "/workspace/project/a/long/directory/tree/with/a/report-file.txt";
    const columns = 18;
    const options = { hard: true, trim: false, wordWrap: false };
    const plainRows = wrapAnsi(path, columns, options).split("\n");
    const linkedRows = wrapAnsi(osc8FileLink({ path, label: path }), columns, options).split("\n");

    expect(linkedRows.map(stripAnsi)).toEqual(plainRows);
    for (const row of linkedRows) {
      const sequences = row.match(OSC8_SEQUENCE_RE) ?? [];
      expect(sequences).toHaveLength(2);
      expect(sequences[0]).not.toMatch(OSC8_CLOSE_RE);
      expect(sequences[1]).toMatch(OSC8_CLOSE_RE);
    }
    expect(linkedRows.map(stripAnsi).join("")).toBe(path);
  });
});

describe("wrapProse", () => {
  // A row that fills the column exactly leaves no room for the space it broke on, so the
  // wrapper carries that space to the next row — which then sits a column further in
  // than its neighbours and breaks the straight left edge the gutter is supposed to have.
  it("does not indent a row with the space it was broken on", () => {
    expect(wrapProse("alpha beta gamma delta epsilon", 11)).toEqual([
      "alpha beta ",
      "gamma delta",
      "epsilon",
    ]);
  });

  it("finds the break space behind the colour sequence that opens the row", () => {
    const [, second] = wrapProse("\x1b[1malpha beta gamma delta\x1b[22m", 10);

    expect(second).toBe("\x1b[1mgamma \x1b[22m");
  });

  // Only the rows the wrapper produced are its own. Whatever the caller put in front of
  // the text — a list marker, a quote — is content and stays where it was written.
  it("keeps the indentation the caller wrote into the first row", () => {
    expect(wrapProse("    - a nested item long enough to wrap", 24)).toEqual([
      "    - a nested item long",
      "enough to wrap",
    ]);
  });

  it("breaks inside a word too long for the column rather than overflowing it", () => {
    expect(wrapProse("short thisisonesingleverylongtoken", 12)).toEqual([
      "short thisis",
      "onesinglever",
      "ylongtoken",
    ]);
  });

  it("can keep long words intact while removing a continuation-row break space", () => {
    expect(
      wrapProse("alpha beta gamma supercalifragilistic", 10, {
        hard: false,
      }),
    ).toEqual(["alpha beta", "gamma ", "supercalifragilistic"]);
  });
});
