import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredThemeBySlug, type StoredTheme } from "@/kernel/theme/store.ts";
import { ThemeEditor } from "@/ui/panels/theme/editor.ts";

let root = "";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.OTHERSIDE_CONFIG_DIR;
  root = mkdtempSync(join(tmpdir(), "theme-editor-"));
  process.env.OTHERSIDE_CONFIG_DIR = root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

function stored(overrides: Record<string, string>): StoredTheme {
  return { slug: "ocean", name: "Ocean", base: "dark", overrides, source: "user" };
}

/** Moves the cursor onto a named slot so the edit lands where the test means. */
function select(editor: ThemeEditor, slot: string): void {
  editor.setFilter(slot);
  editor.moveCursor(editor.rows().findIndex((row) => row.slot === slot));
}

describe("a new theme", () => {
  it("opens on the name screen and holds until the name is usable", () => {
    const editor = new ThemeEditor();
    expect(editor.screen).toBe("name");
    expect(editor.canContinue).toBe(false);
    expect(editor.continueToSlots()).toBe(false);

    editor.name = "Ocean Blue";
    expect(editor.canContinue).toBe(true);
    expect(editor.slug).toBe("ocean-blue");
    expect(editor.continueToSlots()).toBe(true);
    expect(editor.screen).toBe("slots");
  });

  it("shows a save path even before a name is typed", () => {
    expect(new ThemeEditor().displaySlug).toBe("theme");
  });
});

describe("an existing theme", () => {
  it("opens straight on the slot list with its values in hand", () => {
    const editor = new ThemeEditor(stored({ text: "#FF0000" }));
    expect(editor.screen).toBe("slots");
    expect(editor.overrideCount).toBe(1);
    select(editor, "text");
    expect(editor.selected()?.overridden).toBe(true);
    expect(editor.selected()?.current).toBe("#FF0000");
  });

  it("keeps the slots it was opened with when another is saved", () => {
    const editor = new ThemeEditor(stored({ text: "#FF0000" }));
    select(editor, "muted");
    editor.openValue();
    editor.draft = "ansi:green";
    expect(editor.commitValue()).toBe(true);

    expect(readStoredThemeBySlug("ocean")?.overrides).toEqual({
      text: "#FF0000",
      muted: "ansi:green",
    });
  });
});

describe("the value prompt", () => {
  it("refuses a value the style model cannot render", () => {
    const editor = new ThemeEditor(stored({}));
    select(editor, "text");
    editor.openValue();
    editor.draft = "notacolor";
    expect(editor.draftRejected).toBe(true);
    expect(editor.commitValue()).toBe(false);
    expect(editor.screen).toBe("value");
    expect(editor.overrideCount).toBe(0);
  });

  it("returns to the slot list without storing on cancel", () => {
    const editor = new ThemeEditor(stored({}));
    select(editor, "text");
    editor.openValue();
    editor.draft = "#123456";
    editor.cancelValue();
    expect(editor.screen).toBe("slots");
    expect(editor.overrideCount).toBe(0);
  });
});

describe("resetting a slot", () => {
  it("drops the override so the base palette shows through", () => {
    const editor = new ThemeEditor(stored({ text: "#FF0000" }));
    select(editor, "text");
    expect(editor.resetSelected()).toBe(true);
    expect(editor.selected()?.overridden).toBe(false);
    expect(readStoredThemeBySlug("ocean")?.overrides).toEqual({});
  });

  it("does nothing on a slot that was never overridden", () => {
    const editor = new ThemeEditor(stored({}));
    select(editor, "text");
    expect(editor.resetSelected()).toBe(false);
  });
});

describe("the slot filter", () => {
  it("narrows to the slots whose name carries the text", () => {
    const editor = new ThemeEditor(stored({}));
    editor.setFilter("diff");
    const slots = editor.rows().map((row) => row.slot);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.toLowerCase().includes("diff"))).toBe(true);
  });

  it("puts the cursor back on the first match", () => {
    const editor = new ThemeEditor(stored({}));
    editor.moveCursor(5);
    editor.setFilter("diff");
    expect(editor.cursor).toBe(0);
  });
});
