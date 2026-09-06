import { afterEach, describe, expect, test } from "bun:test";
import { transcriptActions, transcriptStore } from "@/store/transcript/index.ts";
import { dismissalText, noteDismissal } from "@/ui/panels/dismissal-notice.ts";

afterEach(() => {
  transcriptActions.replace([]);
});

describe("what a closed panel is called", () => {
  test("names the panel, so a scrollback says what filled the gap", () => {
    expect(dismissalText("config")).toBe("Config dialog dismissed");
    expect(dismissalText("workflows")).toBe("Dynamic workflows dialog dismissed");
    expect(dismissalText("tasks")).toBe("Background tasks dialog dismissed");
  });

  test("says nothing for a panel that leaves no line", () => {
    // A panel opened to answer something (an error, a quota notice) already left
    // its own row; a second one saying it closed is noise.
    expect(dismissalText("error")).toBeNull();
    expect(dismissalText("quota")).toBeNull();
  });
});

describe("the line itself", () => {
  test("lands on the transcript, muted, because it is a record rather than a reading", () => {
    noteDismissal("config");
    const entries = transcriptStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: "Config dialog dismissed", muted: true });
  });

  test("is not written at all for a panel that leaves none", () => {
    noteDismissal("error");
    expect(transcriptStore.getState().entries).toHaveLength(0);
  });
});
