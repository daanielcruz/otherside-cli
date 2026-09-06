import { describe, expect, test } from "bun:test";
import { keybindingFeedback } from "@/commands/handlers/keybindings.ts";

const PATH = "/config/keybindings.json";

describe("what /keybindings tells the reader", () => {
  test("names the file when it loaded clean", () => {
    expect(keybindingFeedback({ path: PATH, created: true, edited: true, problems: [] })).toBe(
      `Loaded ${PATH}.`,
    );
  });

  test("names every refusal with where it was written", () => {
    // The file is hand-edited, so "something was wrong" is not enough to fix it.
    const feedback = keybindingFeedback({
      path: PATH,
      created: false,
      edited: true,
      problems: [
        { at: 'bindings[0].bindings["ctrl+c"]', message: "ctrl+c is reserved — because" },
        { at: "bindings[1].context", message: '"nowhere" is not a context' },
      ],
    });
    expect(feedback).toContain("2 problems");
    expect(feedback).toContain('bindings[0].bindings["ctrl+c"]: ctrl+c is reserved');
    expect(feedback).toContain("bindings[1].context:");
  });

  test("counts one problem in the singular", () => {
    const feedback = keybindingFeedback({
      path: PATH,
      created: false,
      edited: true,
      problems: [{ at: "bindings", message: "expected an array of blocks" }],
    });
    expect(feedback).toContain("1 problem:");
  });

  test("says the file was made when the editor never ran", () => {
    // Creating the file is worth reporting on its own: the reader can go open it.
    expect(
      keybindingFeedback({ path: PATH, created: true, edited: false, problems: [] }),
    ).toContain("Created");
  });

  test("says nothing changed when an existing file was not edited", () => {
    expect(keybindingFeedback({ path: PATH, created: false, edited: false, problems: [] })).toBe(
      `${PATH} is unchanged.`,
    );
  });
});
