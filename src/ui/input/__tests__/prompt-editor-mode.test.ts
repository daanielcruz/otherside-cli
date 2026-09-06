import { describe, expect, it } from "bun:test";
import { editorModeAnnouncement } from "@/ui/input/prompt-chrome.ts";

describe("the editor-mode announcement", () => {
  it("names insert between the dashes", () => {
    expect(editorModeAnnouncement({ name: "insert" })).toBe("-- INSERT --");
  });

  it("names a characterwise selection visual", () => {
    expect(editorModeAnnouncement({ name: "visual", span: "characterwise" })).toBe("-- VISUAL --");
  });

  it("spells out a linewise selection", () => {
    expect(editorModeAnnouncement({ name: "visual", span: "linewise" })).toBe("-- VISUAL LINE --");
  });

  it("announces nothing when there is no mode to announce", () => {
    expect(editorModeAnnouncement(null)).toBeNull();
  });

  it("returns plain text, leaving the colour to the row it rides on", () => {
    const announcement = editorModeAnnouncement({ name: "insert" }) ?? "";

    expect(announcement).not.toContain(String.fromCharCode(27));
  });
});
