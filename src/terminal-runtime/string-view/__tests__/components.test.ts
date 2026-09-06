import { expect, test } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { type StringComponent, StringContainer } from "@/terminal-runtime/string-view/component.js";
import { StringFocusStack } from "@/terminal-runtime/string-view/focus.js";
import { Spacer } from "@/terminal-runtime/string-view/spacer.js";

test("container fans lifecycle events out to children", () => {
  const events: string[] = [];
  const child: StringComponent = {
    mount(ctx) {
      events.push("mount");
      ctx.requestRender();
    },
    unmount() {
      events.push("unmount");
    },
    render: () => [],
  };
  const root = new StringContainer();
  root.addChild(child);

  root.mount({
    requestRender: () => events.push("render"),
    pushFocus: () => {},
    popFocus: () => {},
  });
  root.unmount();

  expect(events).toEqual(["mount", "render", "unmount"]);
});

test("focus routing sends a key only to the top target and restores the fallback", () => {
  const events: string[] = [];
  const focus = new StringFocusStack();
  const prompt = { handleKey: () => events.push("prompt") };
  const overlay = { handleKey: () => events.push("overlay") };
  const key: KeyEventData = {
    kind: "key",
    fn: false,
    name: "down",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: "\u001b[B",
    raw: "\u001b[B",
    isPasted: false,
  };

  focus.push(prompt);
  focus.push(overlay);
  expect(focus.route(key)).toBe(true);
  expect(events).toEqual(["overlay"]);

  focus.pop(overlay);
  expect(focus.route(key)).toBe(true);
  expect(events).toEqual(["overlay", "prompt"]);
  focus.pop(prompt);
  expect(focus.route(key)).toBe(false);
});

test("container clamps the width passed to every child", () => {
  const receivedWidths: number[] = [];
  const child: StringComponent = {
    render(width) {
      receivedWidths.push(width);
      return [String(width)];
    },
  };
  const root = new StringContainer();
  root.addChild(child);

  expect(root.render(0)).toEqual(["1"]);
  expect(receivedWidths).toEqual([1]);
});

test("configured spacers keep their row contract", () => {
  expect(new Spacer(3).render(10)).toEqual(["", "", ""]);
});
