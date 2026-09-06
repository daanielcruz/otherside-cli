import { describe, expect, test } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { DEFAULT_BINDINGS } from "@/ui/keys/defaults.ts";
import { applyBindingOverrides } from "@/ui/keys/overrides.ts";
import { lookupKey } from "@/ui/keys/resolver.ts";

function press(over: Partial<KeyEventData>): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name: undefined,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: undefined,
    raw: undefined,
    isPasted: false,
    ...over,
  };
}

const block = (context: string, bindings: Record<string, unknown>) => ({
  bindings: [{ context, bindings }],
});

describe("a user document layers onto the shipped table", () => {
  test("adds a chord and leaves the rest standing", () => {
    const { table, problems } = applyBindingOverrides(block("select", { n: "select:next" }));
    expect(problems).toEqual([]);
    expect(table.select?.n).toBe("select:next");
    // Everything the shipped table said still holds.
    expect(table.select?.down).toBe("select:next");
    expect(table.panel).toEqual(DEFAULT_BINDINGS.panel);
  });

  test("resolves through the layered table without touching the shipped one", () => {
    const { table } = applyBindingOverrides(block("select", { n: "select:previous" }));
    expect(
      lookupKey({ key: press({ name: "n", sequence: "n" }), contexts: ["select"], table }),
    ).toEqual({ kind: "action", action: "select:previous", context: "select" });
    // The default table is untouched, so a second reader is unaffected.
    expect(DEFAULT_BINDINGS.select?.n).toBeUndefined();
  });

  test("takes a key back with null, and with undefined", () => {
    const withNull = applyBindingOverrides(block("select", { j: null }));
    expect(withNull.table.select?.j).toBeUndefined();
    expect(withNull.problems).toEqual([]);
    // JSON has no `undefined`, but a JS document writes one and means the same.
    const withUndefined = applyBindingOverrides(block("select", { j: undefined }));
    expect(withUndefined.table.select?.j).toBeUndefined();
  });

  test("normalizes a chord as it is written, so spelling does not matter", () => {
    const { table } = applyBindingOverrides(block("select", { "Control+N": "select:next" }));
    expect(table.select?.["ctrl+n"]).toBe("select:next");
  });

  test("layers two blocks naming one context instead of replacing", () => {
    const { table } = applyBindingOverrides({
      bindings: [
        { context: "select", bindings: { n: "select:next" } },
        { context: "select", bindings: { p: "select:previous" } },
      ],
    });
    expect(table.select?.n).toBe("select:next");
    expect(table.select?.p).toBe("select:previous");
  });
});

describe("what it refuses, and what it says", () => {
  test("refuses a reserved key outright when leaving is at stake", () => {
    const { table, problems } = applyBindingOverrides(block("select", { "ctrl+c": "select:next" }));
    expect(table.select?.["ctrl+c"]).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("reserved");
    expect(problems[0]?.at).toContain("ctrl+c");
  });

  test("applies a warned key anyway, because the emulator decides that one", () => {
    const { table, problems } = applyBindingOverrides(block("select", { "ctrl+z": "select:next" }));
    expect(table.select?.["ctrl+z"]).toBe("select:next");
    expect(problems).toHaveLength(1);
  });

  test("names an unknown action, an unknown context and an unreadable chord", () => {
    expect(
      applyBindingOverrides(block("select", { n: "select:nope" })).problems[0]?.message,
    ).toContain("is not an action");
    expect(
      applyBindingOverrides(block("nowhere", { n: "select:next" })).problems[0]?.message,
    ).toContain("is not a context");
    expect(
      applyBindingOverrides(block("select", { "": "select:next" })).problems[0]?.message,
    ).toContain("is not a key combination");
  });

  test("says which action a chord already had, and lets the later one win", () => {
    const { table, problems } = applyBindingOverrides(block("select", { down: "select:previous" }));
    expect(table.select?.down).toBe("select:previous");
    expect(problems[0]?.message).toContain("already performs select:next");
  });

  test("changes nothing when the document is not one", () => {
    for (const document of [null, 42, "bindings", [], {}, { bindings: 7 }]) {
      const { table, problems } = applyBindingOverrides(document);
      expect(table).toBe(DEFAULT_BINDINGS);
      expect(problems).toHaveLength(1);
    }
  });

  test("skips a malformed block and keeps reading the rest", () => {
    const { table, problems } = applyBindingOverrides({
      bindings: [{ context: "select" }, { context: "select", bindings: { n: "select:next" } }],
    });
    expect(problems).toHaveLength(1);
    expect(table.select?.n).toBe("select:next");
  });
});
