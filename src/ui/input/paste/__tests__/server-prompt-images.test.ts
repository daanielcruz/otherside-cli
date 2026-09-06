import { describe, expect, test } from "bun:test";
import { promptText } from "@/engine/mcp/prompts.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import { expandToContentBlocks } from "@/ui/input/paste/references.ts";

/**
 * An image a server put in a prompt travels as a reference in the text and is
 * turned back into a picture when the turn expands it. Held and expanded are
 * two different modules, so only the round trip proves the image arrived.
 */

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function imageResult() {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          { type: "image", data: PIXEL, mimeType: "image/png" },
        ],
      },
    ],
  };
}

function heldInto(store: ReturnType<typeof createPasteStore>): string {
  return promptText(
    imageResult(),
    (image) =>
      store.add({ type: "image", content: image.base64, mediaType: image.mediaType }).placeholder,
  );
}

describe("an image a prompt returned", () => {
  test("reaches the turn as an image, not as the words standing in for it", () => {
    const store = createPasteStore("session-under-test");

    const { blocks } = expandToContentBlocks(heldInto(store), store);

    const images = blocks.filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PIXEL },
    });
  });

  test("keeps the words that came with it", () => {
    const store = createPasteStore("session-under-test");

    const { blocks } = expandToContentBlocks(heldInto(store), store);

    const said = blocks
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("");
    expect(said).toContain("Look at this:");
  });

  test("is dropped rather than left as a broken reference when nothing can hold it", () => {
    // No store to put it in, so there is no reference to expand later.
    expect(promptText(imageResult(), () => null)).toBe("Look at this:");
  });
});
