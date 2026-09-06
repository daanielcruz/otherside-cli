import { describe, expect, test } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { isKeyAction, isKeyContext } from "@/ui/keys/actions.ts";
import { normalizeChord } from "@/ui/keys/chord.ts";
import { DEFAULT_BINDINGS } from "@/ui/keys/defaults.ts";
import { isReservedKey } from "@/ui/keys/reserved.ts";
import { lookupKey } from "@/ui/keys/resolver.ts";

const entries = Object.entries(DEFAULT_BINDINGS);

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

describe("the table is well formed", () => {
  test("every context is a declared context", () => {
    for (const [context] of entries) expect(isKeyContext(context)).toBe(true);
  });

  test("every action is a declared action", () => {
    for (const [context, bindings] of entries) {
      for (const action of Object.values(bindings)) {
        expect(`${context}:${action}`).toBe(`${context}:${action}`);
        expect(isKeyAction(action)).toBe(true);
      }
    }
  });

  test("every chord is already normalized", () => {
    for (const [context, bindings] of entries) {
      for (const chord of Object.keys(bindings)) {
        expect(`${context} ${chord} -> ${normalizeChord(chord)}`).toBe(
          `${context} ${chord} -> ${chord}`,
        );
      }
    }
  });

  test("no context is empty — a context with no bindings is not a context", () => {
    for (const [context, bindings] of entries) {
      expect(`${context}:${Object.keys(bindings).length > 0}`).toBe(`${context}:true`);
    }
  });
});

/**
 * The surfaces are the truth while they still own their switches, so these pin
 * the table to what a reader gets today rather than to what it could be.
 */
describe("the table agrees with the surfaces it describes", () => {
  test("the list vocabulary carries both the arrows and their letters", () => {
    expect(DEFAULT_BINDINGS.select.down).toBe("select:next");
    expect(DEFAULT_BINDINGS.select.j).toBe("select:next");
    expect(DEFAULT_BINDINGS.select["ctrl+n"]).toBe("select:next");
    expect(DEFAULT_BINDINGS.select.up).toBe("select:previous");
    expect(DEFAULT_BINDINGS.select.k).toBe("select:previous");
    expect(DEFAULT_BINDINGS.select["ctrl+p"]).toBe("select:previous");
  });

  test("the editor chord is the only two-step binding", () => {
    const multiStep = entries.flatMap(([context, bindings]) =>
      Object.keys(bindings)
        .filter((chord) => chord.includes(" "))
        .map((chord) => `${context}/${chord}`),
    );
    expect(multiStep).toEqual(["prompt/ctrl+x ctrl+e"]);
  });

  test("the transcript reader tells g and G apart", () => {
    expect(DEFAULT_BINDINGS.transcript.g).toBe("transcript:top");
    expect(DEFAULT_BINDINGS.transcript.G).toBe("transcript:bottom");
    expect(DEFAULT_BINDINGS.transcript.n).toBe("transcript:nextMatch");
    expect(DEFAULT_BINDINGS.transcript.N).toBe("transcript:previousMatch");
  });

  test("the stash keeps ctrl+s and the prompt keeps its own escape", () => {
    expect(DEFAULT_BINDINGS.prompt["ctrl+s"]).toBe("prompt:stash");
    expect(DEFAULT_BINDINGS.prompt.escape).toBe("prompt:armClear");
  });

  test("the strip stops a row with x and nothing else", () => {
    expect(DEFAULT_BINDINGS.strip.x).toBe("strip:stopOrClose");
    expect(DEFAULT_BINDINGS.strip.f).toBeUndefined();
    expect(DEFAULT_BINDINGS.strip.k).toBeUndefined();
  });

  test("the notice dismissal is not an action at all", () => {
    // It clears on backspace while that press keeps its editing job, and one chord
    // in one context resolves to exactly one action. Naming it would put an id in
    // the vocabulary that nothing could ever bind.
    expect(isKeyAction("prompt:dismissNotice")).toBe(false);
  });

  test("backgrounding the tool lives in the turn context, pushed while one runs", () => {
    // A stack alone cannot say "outer wins when running". The state IS a context:
    // present while the turn is, so innermost-first then gives the right answer
    // both times — backgrounding while a turn runs, a caret move otherwise.
    expect(DEFAULT_BINDINGS.turn["ctrl+b"]).toBe("app:backgroundTool");
    expect(DEFAULT_BINDINGS.app["ctrl+b"]).toBeUndefined();
    expect(DEFAULT_BINDINGS.edit["ctrl+b"]).toBe("edit:movePreviousChar");
    expect(
      lookupKey({ key: press({ name: "b", ctrl: true }), contexts: ["turn", "edit"] }),
    ).toMatchObject({ action: "app:backgroundTool" });
    expect(lookupKey({ key: press({ name: "b", ctrl: true }), contexts: ["edit"] })).toMatchObject({
      action: "edit:movePreviousChar",
    });
  });

  test("the transcript binds ctrl+d, which only the reserved tiers refuse", () => {
    // Reserved keys guard what a USER may rebind; the shipped table is not asked.
    // Different contexts, so there is no runtime conflict — pinned here so a future
    // edit has to justify itself rather than quietly moving it.
    expect(DEFAULT_BINDINGS.transcript["ctrl+d"]).toBe("transcript:halfPageDown");
    expect(isReservedKey("ctrl+d")).toBe(true);
  });

  test("escape means something in seven contexts and is ordered by none of them", () => {
    // Its real precedence is the ladder in string-view-prompt.ts, which runs before
    // a lookup would. These entries say what escape MEANS in a context, never which
    // context gets it.
    const withEscape = entries.filter(([, bindings]) => bindings.escape !== undefined);
    expect(withEscape.length).toBeGreaterThanOrEqual(7);
  });
});

describe("the turn context is what makes ctrl+b answer twice", () => {
  test("backgrounds while a turn runs and moves the caret without one", () => {
    // The root pushes `turn` only while a turn runs. This is the whole decision:
    // present, it wins innermost; absent, the prompt's own binding answers.
    const chord = press({ name: "b", ctrl: true });
    expect(lookupKey({ key: chord, contexts: ["turn", "edit"] })).toMatchObject({
      action: "app:backgroundTool",
    });
    expect(lookupKey({ key: chord, contexts: ["edit"] })).toMatchObject({
      action: "edit:movePreviousChar",
    });
  });

  test("nothing else claims the chord, so the two answers are the only two", () => {
    const chord = press({ name: "b", ctrl: true });
    expect(lookupKey({ key: chord, contexts: ["turn"] })).toMatchObject({
      action: "app:backgroundTool",
    });
    expect(lookupKey({ key: chord, contexts: ["app"] })).toEqual({ kind: "none" });
  });
});
