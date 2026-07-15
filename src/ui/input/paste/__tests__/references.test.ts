import { describe, expect, it } from "bun:test";
import { formatTruncatedRef, parsePasteReferences } from "@/kernel/std/paste/ref.ts";
import type { PastedContent } from "@/kernel/std/types/paste.ts";
import {
  expandToContentBlocks,
  INPUT_TRUNCATION_THRESHOLD,
  maybeTruncateBuffer,
} from "../references.ts";

function fakeStore(): {
  add: (item: Omit<PastedContent, "id">) => { id: number; placeholder: string };
  get: (id: number) => PastedContent | undefined;
  items: Map<number, PastedContent>;
} {
  const items = new Map<number, PastedContent>();
  let nextId = 1;
  return {
    items,
    add(item) {
      const id = nextId++;
      items.set(id, { id, ...item });
      return { id, placeholder: `[Pasted text #${id}]` };
    },
    get(id) {
      return items.get(id);
    },
  };
}

describe("maybeTruncateBuffer", () => {
  it("leaves text at the threshold untouched", () => {
    const store = fakeStore();
    expect(maybeTruncateBuffer("x".repeat(INPUT_TRUNCATION_THRESHOLD), store)).toBeNull();
    expect(store.items.size).toBe(0);
  });

  it("collapses the middle above the threshold, keeping 500-char head and tail", () => {
    const store = fakeStore();
    const head = "h".repeat(500);
    const tail = "t".repeat(500);
    const middle = `${"m".repeat(9500)}\n\n`;
    const result = maybeTruncateBuffer(head + middle + tail, store);
    expect(result).not.toBeNull();
    expect(result?.startsWith(head)).toBe(true);
    expect(result?.endsWith(tail)).toBe(true);
    expect(result).toContain("[...Truncated text #1 +2 lines...]");
    expect(store.get(1)?.content).toBe(middle);
  });

  it("the truncated reference is atomic for cursor navigation", () => {
    const refs = parsePasteReferences("abc [...Truncated text #3 +12 lines...] def");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBe(3);
  });
});

describe("expandToContentBlocks — truncated refs", () => {
  it("re-expands a truncated reference to the full stored text", () => {
    const store = fakeStore();
    const middle = "the hidden middle\nwith lines";
    const { id } = store.add({ type: "text", content: middle });
    const text = `head ${formatTruncatedRef(id, middle)} tail`;
    const { blocks, text: plain } = expandToContentBlocks(text, store);
    expect(plain).toBe(`head ${middle} tail`);
    expect(blocks.map((b) => (b.type === "text" ? b.text : ""))).toEqual([
      "head ",
      middle,
      " tail",
    ]);
  });

  it("keeps the literal placeholder when the store lost the entry", () => {
    const store = fakeStore();
    const text = "head [...Truncated text #9 +4 lines...] tail";
    const { text: plain } = expandToContentBlocks(text, store);
    expect(plain).toBe(text);
  });
});
