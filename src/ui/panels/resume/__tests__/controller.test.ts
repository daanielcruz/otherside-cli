import { describe, expect, it } from "bun:test";
import type { Key } from "@/terminal-runtime";
import { resumeKeyAction, submitResumeSelection } from "../controller";

const key = (partial: Partial<Key>): Key => partial as Key;

describe("resumeKeyAction", () => {
  const context = { selectedIndex: 0, queryLength: 0 };

  it("applies the mode-scoped Escape transitions", () => {
    expect(resumeKeyAction("rename", "", key({ escape: true }), context)).toEqual({
      type: "back-to-list",
    });
    expect(resumeKeyAction("preview", "", key({ escape: true }), context)).toEqual({
      type: "back-to-list",
    });
    expect(
      resumeKeyAction("search", "", key({ escape: true }), { ...context, queryLength: 1 }),
    ).toEqual({
      type: "clear-search",
    });
    expect(resumeKeyAction("search", "", key({ escape: true }), context)).toEqual({
      type: "back-to-list",
    });
    expect(resumeKeyAction("list", "", key({ escape: true }), context)).toEqual({ type: "close" });
  });

  it("enters search for slash and printable input without treating space as text", () => {
    expect(resumeKeyAction("list", "/", key({}), context)).toEqual({
      type: "enter-search",
      seed: "",
    });
    expect(resumeKeyAction("list", "x", key({}), context)).toEqual({
      type: "enter-search",
      seed: "x",
    });
    expect(resumeKeyAction("list", " ", key({}), context)).toEqual({ type: "preview" });
  });

  it("maps navigation, preview, rename, and resume commands", () => {
    expect(resumeKeyAction("list", "", key({ downArrow: true }), context)).toEqual({
      type: "move",
      delta: 1,
    });
    expect(resumeKeyAction("list", "", key({ pageDown: true }), context)).toEqual({
      type: "page",
      delta: 1,
    });
    expect(resumeKeyAction("list", "r", key({ ctrl: true }), context)).toEqual({
      type: "enter-rename",
    });
    expect(resumeKeyAction("list", "", key({ return: true }), context)).toEqual({
      type: "resume",
    });
    expect(resumeKeyAction("search", "", key({ backspace: true }), context)).toEqual({
      type: "search-delete",
    });
    expect(resumeKeyAction("preview", "", key({ pageUp: true }), context)).toEqual({
      type: "preview-page",
      delta: -1,
    });
    expect(resumeKeyAction("preview", "", key({ return: true }), context)).toEqual({
      type: "resume",
    });
    expect(resumeKeyAction("rename", "x", key({}), context)).toEqual({
      type: "rename-append",
      text: "x",
    });
    expect(resumeKeyAction("rename", "", key({ backspace: true }), context)).toEqual({
      type: "rename-delete",
    });
    expect(resumeKeyAction("rename", "", key({ return: true }), context)).toEqual({
      type: "rename-save",
    });
  });

  it("closes exactly once after a successful resume", async () => {
    const resumed: string[] = [];
    let closes = 0;

    const error = await submitResumeSelection(
      "session-id",
      async (id) => {
        resumed.push(id);
      },
      () => {
        closes += 1;
      },
    );

    expect(error).toBeNull();
    expect(resumed).toEqual(["session-id"]);
    expect(closes).toBe(1);
  });

  it("keeps the panel open and returns synchronous and asynchronous errors", async () => {
    let closes = 0;
    const close = () => {
      closes += 1;
    };

    expect(
      await submitResumeSelection(
        "sync",
        () => {
          throw new Error("wrong directory");
        },
        close,
      ),
    ).toBe("wrong directory");
    expect(
      await submitResumeSelection(
        "async",
        async () => {
          throw new Error("missing session");
        },
        close,
      ),
    ).toBe("missing session");
    expect(closes).toBe(0);
  });
});
