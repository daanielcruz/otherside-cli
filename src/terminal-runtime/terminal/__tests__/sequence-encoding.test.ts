import { describe, expect, it } from "bun:test";
import { pathToFileURL } from "node:url";
import { ERASE_DISPLAY_TO_END } from "@/terminal-runtime/terminal/control-sequences.ts";
import { sgr } from "@/terminal-runtime/terminal/graphic-rendition.ts";
import { osc8FileLink, osc8UrlLink } from "@/terminal-runtime/terminal/hyperlink-sequences.ts";
import {
  OSC,
  oscWithStringTerminator,
} from "@/terminal-runtime/terminal/operating-system-command.ts";
import {
  readPresentationSequence,
  stripAnsi,
} from "@/terminal-runtime/text/presentation-sequences.ts";

const ESC = "\u001b";

describe("terminal sequence encoding", () => {
  it("keeps fixed string-terminated OSC bytes", () => {
    expect(oscWithStringTerminator(OSC.SET_TITLE_AND_ICON, "Otherside CLI")).toBe(
      `${ESC}]0;Otherside CLI${ESC}\\`,
    );
  });

  it("keeps explicit SGR and erase-display parameters", () => {
    expect(sgr(1)).toBe(`${ESC}[1m`);
    expect(sgr(22)).toBe(`${ESC}[22m`);
    expect(sgr(31)).toBe(`${ESC}[31m`);
    expect(sgr(39)).toBe(`${ESC}[39m`);
    expect(ERASE_DISPLAY_TO_END).toBe(`${ESC}[0J`);
  });

  it("encodes URL links with a string terminator", () => {
    expect(osc8UrlLink({ url: "https://example.test/a;b", label: "site" })).toBe(
      `${ESC}]8;;https://example.test/a;b${ESC}\\site${ESC}]8;;${ESC}\\`,
    );
  });

  it("drops control bytes from hyperlink labels", () => {
    expect(osc8UrlLink({ url: "https://example.test", label: "bad\u0007label" })).toContain(
      `${ESC}\\badlabel${ESC}]8`,
    );
  });

  it("converts file paths without changing link framing", () => {
    const path = "/workspace/project/report.txt";
    expect(osc8FileLink({ path, label: "report" })).toContain(pathToFileURL(path).href);
  });
});

describe("presentation sequence parsing", () => {
  it("reads SGR and both OSC terminators without consuming text", () => {
    expect(readPresentationSequence(`${ESC}[31mred`, 0)).toEqual({
      value: `${ESC}[31m`,
      next: 5,
    });
    expect(readPresentationSequence(`${ESC}]8;;url\u0007label`, 0)).toEqual({
      value: `${ESC}]8;;url\u0007`,
      next: 9,
    });
    expect(readPresentationSequence(`${ESC}]8;;url${ESC}\\label`, 0)).toEqual({
      value: `${ESC}]8;;url${ESC}\\`,
      next: 10,
    });
  });

  it("strips only the presentation sequences covered by the projection contract", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`${ESC}[2Jkept`)).toBe(`${ESC}[2Jkept`);
  });
});
