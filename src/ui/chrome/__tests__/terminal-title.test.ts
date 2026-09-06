import { afterEach, describe, expect, it } from "bun:test";
import { dispatch } from "@/store/app-store/index.ts";
import { sessionTitleActions } from "@/store/session-title/index.ts";
import { OSC, osc } from "@/terminal-runtime/terminal/operating-system-command.js";
import {
  BUSY_CAPTION_MARKS,
  buildWindowCaption,
  CAPTION_STEP_MS,
  captionMark,
  captionSuppressed,
  FALLBACK_CAPTION,
  IDLE_CAPTION_MARK,
  startWindowCaption,
} from "@/ui/chrome/window-caption.ts";

afterEach(() => {
  sessionTitleActions.reset();
  dispatch({ type: "view/setBusy", busy: false });
  delete process.env.OTHERSIDE_DISABLE_TERMINAL_TITLE;
});

describe("captionSuppressed", () => {
  it("treats unset and falsy values as enabled", () => {
    expect(captionSuppressed(undefined)).toBe(false);
    expect(captionSuppressed("0")).toBe(false);
    expect(captionSuppressed("false")).toBe(false);
    expect(captionSuppressed("off")).toBe(false);
  });

  it("treats any other set value as disabled", () => {
    expect(captionSuppressed("1")).toBe(true);
    expect(captionSuppressed("true")).toBe(true);
    expect(captionSuppressed("yes")).toBe(true);
  });
});

describe("captionMark and buildWindowCaption", () => {
  it("uses the product glyph when idle", () => {
    expect(captionMark(false, 0)).toBe(IDLE_CAPTION_MARK);
    expect(captionMark(false, 99)).toBe(IDLE_CAPTION_MARK);
  });

  it("cycles the busy braille frames", () => {
    expect(captionMark(true, 0)).toBe(BUSY_CAPTION_MARKS[0]);
    expect(captionMark(true, 1)).toBe(BUSY_CAPTION_MARKS[1]);
    expect(captionMark(true, 2)).toBe(BUSY_CAPTION_MARKS[0]);
  });

  it("formats idle default and busy custom titles", () => {
    expect(buildWindowCaption({ title: null, busy: false, motionStep: 0, suppressed: false })).toBe(
      `${IDLE_CAPTION_MARK} ${FALLBACK_CAPTION}`,
    );

    expect(
      buildWindowCaption({
        title: "Ship the renderer",
        busy: true,
        motionStep: 1,
        suppressed: false,
      }),
    ).toBe(`${BUSY_CAPTION_MARKS[1]} Ship the renderer`);
  });

  it("returns null when titles are disabled", () => {
    expect(
      buildWindowCaption({ title: "x", busy: false, motionStep: 0, suppressed: true }),
    ).toBeNull();
  });

  it("sanitizes markup out of the session title body", () => {
    expect(
      buildWindowCaption({
        title: "**Bold** <em>title</em>",
        busy: false,
        motionStep: 0,
        suppressed: false,
      }),
    ).toBe(`${IDLE_CAPTION_MARK} Bold title`);
  });
});

describe("startWindowCaption", () => {
  it("emits idle then busy titles on store transitions", () => {
    if (process.platform === "win32") return;

    const writes: string[] = [];
    const stop = startWindowCaption({
      emit: (bytes) => writes.push(bytes),
    });

    expect(writes[0]).toBe(osc(OSC.SET_TITLE_AND_ICON, `${IDLE_CAPTION_MARK} ${FALLBACK_CAPTION}`));

    sessionTitleActions.setTitle("Working");
    expect(writes.at(-1)).toBe(osc(OSC.SET_TITLE_AND_ICON, `${IDLE_CAPTION_MARK} Working`));

    dispatch({ type: "view/setBusy", busy: true });
    expect(writes.at(-1)).toBe(osc(OSC.SET_TITLE_AND_ICON, `${BUSY_CAPTION_MARKS[0]} Working`));

    dispatch({ type: "view/setBusy", busy: false });
    expect(writes.at(-1)).toBe(osc(OSC.SET_TITLE_AND_ICON, `${IDLE_CAPTION_MARK} Working`));

    stop();
    expect(CAPTION_STEP_MS).toBe(960);
  });

  it("does not write when titles are disabled by env", () => {
    process.env.OTHERSIDE_DISABLE_TERMINAL_TITLE = "1";
    const writes: string[] = [];
    const stop = startWindowCaption({
      emit: (bytes) => writes.push(bytes),
    });
    expect(writes).toEqual([]);
    stop();
  });
});
