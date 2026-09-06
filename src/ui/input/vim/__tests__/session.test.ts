import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { VimSession } from "@/ui/input/vim/session.ts";
import type { VimBuffer, VimSettings } from "@/ui/input/vim/types.ts";

const ENABLED: VimSettings = { enabled: true, indicatorHidden: false };
const DISABLED: VimSettings = { enabled: false, indicatorHidden: false };

function key(sequence: string, overrides: Partial<KeyEventData> = {}): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name: sequence,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
    ...overrides,
  };
}

const ESCAPE = key("escape", { name: "escape", sequence: "\x1b" });

/** The session plus the prompt stand-in it drives, so a test can read both. */
function session(text: string, caret: number, settings: VimSettings = ENABLED, columns = 80) {
  const state = { text, caret, moves: 0, undo: [] as { text: string; caret: number }[] };
  const bridge: VimBuffer = {
    getText: () => state.text,
    getCaretOffset: () => state.caret,
    getColumns: () => columns,
    moveTo: (offset) => {
      state.caret = offset;
      state.moves += 1;
    },
    applyEdit: (edit) => {
      state.undo.push({ text: state.text, caret: state.caret });
      state.text = edit.text;
      state.caret = edit.caret;
      state.moves += 1;
    },
    undoLastEdit: () => {
      const step = state.undo.pop();
      if (step === undefined) return;
      state.text = step.text;
      state.caret = step.caret;
    },
  };
  return { vim: new VimSession(bridge, settings), state };
}

/** Feeds a command as the reader types it, one key at a time. */
function type(vim: VimSession, keys: string): void {
  for (const char of keys) vim.handleKey(key(char));
}

describe("vim session — the mode is off", () => {
  it("declines every key and announces nothing", () => {
    const { vim, state } = session("draft", 5, DISABLED);

    expect(vim.handleKey(ESCAPE)).toBe(false);
    expect(vim.handleKey(key("i"))).toBe(false);
    expect(vim.indicatorMode()).toBeNull();
    expect(state.caret).toBe(5);
  });
});

describe("vim session — leaving insert", () => {
  it("steps the caret back onto the character just typed", () => {
    const { vim, state } = session("hello", 5);

    expect(vim.handleKey(ESCAPE)).toBe(true);

    expect(vim.currentMode()).toEqual({ name: "normal" });
    expect(state.caret).toBe(4);
  });

  it("holds the caret at the start of the buffer, and still asks for a repaint", () => {
    const { vim, state } = session("hello", 0);

    expect(vim.handleKey(ESCAPE)).toBe(true);

    expect(state.caret).toBe(0);
    // A mode change with nowhere to move is still a visible change.
    expect(state.moves).toBe(1);
  });

  it("holds the caret at the start of a line", () => {
    const { vim, state } = session("one\ntwo", 4);

    expect(vim.handleKey(ESCAPE)).toBe(true);
    expect(state.caret).toBe(4);
  });

  it("hands Escape to the prompt's own ladder once normal is reached", () => {
    const { vim } = session("hello", 5);
    vim.handleKey(ESCAPE);

    expect(vim.handleKey(ESCAPE)).toBe(false);
    expect(vim.currentMode()).toEqual({ name: "normal" });
  });
});

describe("vim session — entering insert", () => {
  function inNormal(text: string, caret: number) {
    const made = session(text, caret);
    made.vim.handleKey(ESCAPE);
    made.state.caret = caret;
    return made;
  }

  it("i leaves the caret where it stands", () => {
    const { vim, state } = inNormal("hello", 3);

    expect(vim.handleKey(key("i"))).toBe(true);
    expect(vim.currentMode()).toEqual({ name: "insert" });
    expect(state.caret).toBe(3);
  });

  it("a steps one character right", () => {
    const { vim, state } = inNormal("hello", 3);

    expect(vim.handleKey(key("a"))).toBe(true);
    expect(state.caret).toBe(4);
  });

  it("A lands at the end of the line, not the end of the buffer", () => {
    const { vim, state } = inNormal("one\ntwo", 1);

    expect(vim.handleKey(key("A"))).toBe(true);
    expect(state.caret).toBe(3);
  });

  it("I lands past the indentation, not at the line's first column", () => {
    const { vim, state } = inNormal("one\n    two", 9);

    expect(vim.handleKey(key("I"))).toBe(true);
    expect(state.caret).toBe(8);
  });

  it("I on a blank line stops at the line end rather than running past it", () => {
    const { vim, state } = inNormal("one\n   \nthree", 5);

    expect(vim.handleKey(key("I"))).toBe(true);
    expect(state.caret).toBe(7);
  });
});

describe("vim session — normal swallows what it cannot yet do", () => {
  function inNormal(text: string, caret: number) {
    const made = session(text, caret);
    made.vim.handleKey(ESCAPE);
    made.state.caret = caret;
    return made;
  }

  it("keeps an unimplemented command out of the buffer", () => {
    const { vim, state } = inNormal("hello", 2);

    expect(vim.handleKey(key("d"))).toBe(true);
    expect(vim.currentMode()).toEqual({ name: "normal" });
    expect(state.caret).toBe(2);
  });

  it("lets a named navigation or submission key through", () => {
    const { vim } = inNormal("hello", 2);

    expect(vim.handleKey(key("return", { sequence: "\r" }))).toBe(false);
    expect(vim.handleKey(key("up", { sequence: "\x1b[A" }))).toBe(false);
  });

  it("lets a chord keep its editing meaning", () => {
    const { vim } = inNormal("hello", 2);

    expect(vim.handleKey(key("c", { ctrl: true }))).toBe(false);
    expect(vim.handleKey(key("f", { meta: true }))).toBe(false);
  });
});

describe("vim session — what the indicator announces", () => {
  it("names insert and stays silent in normal", () => {
    const { vim } = session("hello", 5);

    expect(vim.indicatorMode()).toEqual({ name: "insert" });
    vim.handleKey(ESCAPE);
    expect(vim.indicatorMode()).toBeNull();
  });

  it("stays silent when the status line renders the mode itself", () => {
    const { vim } = session("hello", 5, { enabled: true, indicatorHidden: true });

    expect(vim.indicatorMode()).toBeNull();
  });
});

describe("vim session — motions in normal", () => {
  /** A session already in normal, caret placed by offset. */
  function normal(text: string, caret: number, columns = 80) {
    const made = session(text, caret, ENABLED, columns);
    made.vim.handleKey(ESCAPE);
    return made;
  }

  it("walks characters and stops at the line edges", () => {
    const { vim, state } = normal("abc", 1);
    // Escape stepped back onto the character just typed.
    expect(state.caret).toBe(0);
    type(vim, "l");
    expect(state.caret).toBe(1);
    type(vim, "lll");
    // A normal caret rests ON the last grapheme, never past it.
    expect(state.caret).toBe(2);
    type(vim, "hhhh");
    expect(state.caret).toBe(0);
  });

  it("takes a count and caps it", () => {
    const { vim, state } = normal("abcdefghij", 1);
    type(vim, "5l");
    expect(state.caret).toBe(5);
    type(vim, "99999l");
    expect(state.caret).toBe(9);
  });

  it("reads 0 as the line start only when no count is open", () => {
    const { vim, state } = normal("abcdefghij", 1);
    type(vim, "4l");
    expect(state.caret).toBe(4);
    type(vim, "0");
    expect(state.caret).toBe(0);
    // Inside a count the same key is a digit: 10l moves ten, not to the start.
    type(vim, "10l");
    expect(state.caret).toBe(9);
  });

  it("walks words, small and big", () => {
    const { vim, state } = normal("foo.bar baz", 1);
    expect(state.caret).toBe(0);
    type(vim, "w");
    expect(state.caret).toBe(3);
    type(vim, "w");
    expect(state.caret).toBe(4);
    type(vim, "0W");
    expect(state.caret).toBe(8);
    type(vim, "b");
    expect(state.caret).toBe(4);
    type(vim, "0e");
    expect(state.caret).toBe(2);
  });

  it("finds a character in the line and repeats the search", () => {
    const { vim, state } = normal("a.b.c.d", 1);
    expect(state.caret).toBe(0);
    type(vim, "f.");
    expect(state.caret).toBe(1);
    type(vim, ";");
    expect(state.caret).toBe(3);
    type(vim, ",");
    expect(state.caret).toBe(1);
    // `t` stops one short of the match.
    type(vim, "0t.");
    expect(state.caret).toBe(0);
    type(vim, "2t.");
    expect(state.caret).toBe(2);
  });

  it("takes the g prefix to the first line and rows", () => {
    const { vim, state } = normal("one\ntwo\nthree", 12);
    type(vim, "gg");
    expect(state.caret).toBe(0);
    type(vim, "G");
    expect(state.caret).toBe(8);
    type(vim, "2G");
    expect(state.caret).toBe(4);
    type(vim, "1G");
    expect(state.caret).toBe(0);
  });

  it("spends a g that nothing completes", () => {
    const { vim, state } = normal("one\ntwo", 6);
    const before = state.caret;
    type(vim, "gz");
    expect(state.caret).toBe(before);
    // The prefix is gone, so a following g starts a fresh one rather than firing gg.
    type(vim, "g");
    expect(state.caret).toBe(before);
    type(vim, "g");
    expect(state.caret).toBe(0);
  });

  it("holds a swallowed key out of the buffer", () => {
    const { vim, state } = normal("abc", 1);
    expect(vim.handleKey(key("z"))).toBe(true);
    expect(state.text).toBe("abc");
  });

  it("cancels a half-typed command with escape, then yields the key", () => {
    const { vim } = normal("abcdef", 1);
    expect(vim.handleKey(key("5"))).toBe(true);
    // The count is what escape cancels, so the key is spent.
    expect(vim.handleKey(ESCAPE)).toBe(true);
    // With nothing half-typed the prompt's own ladder gets it.
    expect(vim.handleKey(ESCAPE)).toBe(false);
  });

  it("enters insert at the four places", () => {
    const { vim, state } = normal("  abc", 5);
    expect(state.caret).toBe(4);
    type(vim, "i");
    expect(vim.currentMode().name).toBe("insert");
    vim.handleKey(ESCAPE);
    type(vim, "I");
    expect(state.caret).toBe(2);
    vim.handleKey(ESCAPE);
    type(vim, "A");
    expect(state.caret).toBe(5);
    vim.handleKey(ESCAPE);
    type(vim, "a");
    expect(state.caret).toBe(5);
  });
});

describe("vim session — operators", () => {
  function normal(text: string, caret: number, columns = 80) {
    const made = session(text, caret, ENABLED, columns);
    made.vim.handleKey(ESCAPE);
    return made;
  }

  it("deletes to a motion, exclusive and inclusive", () => {
    const forward = normal("one two three", 1);
    type(forward.vim, "dw");
    expect(forward.state.text).toBe("two three");

    const inclusive = normal("one two", 1);
    // `e` lands on the last grapheme of the word, and `de` takes it with it.
    type(inclusive.vim, "de");
    expect(inclusive.state.text).toBe(" two");
  });

  it("deletes backward from the caret, leaving its own grapheme", () => {
    const { vim, state } = normal("one two", 5);
    expect(state.caret).toBe(4);
    // `b` reaches the previous word's start, so the span is everything before
    // the caret and nothing at it.
    type(vim, "db");
    expect(state.text).toBe("two");
  });

  it("takes whole lines when doubled, and leaves no blank behind", () => {
    const middle = normal("one\ntwo\nthree", 5);
    type(middle.vim, "dd");
    expect(middle.state.text).toBe("one\nthree");

    const last = normal("one\ntwo", 5);
    type(last.vim, "dd");
    expect(last.state.text).toBe("one");

    const several = normal("a\nb\nc\nd", 0);
    type(several.vim, "3dd");
    expect(several.state.text).toBe("d");
  });

  it("multiplies the counts around an operator", () => {
    const { vim, state } = normal("a b c d e f g", 0);
    type(vim, "2d3w");
    expect(state.text).toBe("g");
  });

  it("changes a span and ends in insert", () => {
    const { vim, state } = normal("one two", 1);
    type(vim, "cw");
    expect(state.text).toBe(" two");
    expect(vim.currentMode().name).toBe("insert");
  });

  it("empties a changed line instead of removing it", () => {
    const { vim, state } = normal("one\ntwo", 5);
    type(vim, "cc");
    expect(state.text).toBe("one\n");
    expect(vim.currentMode().name).toBe("insert");
  });

  it("yanks without changing the draft, then pastes it", () => {
    const { vim, state } = normal("one two", 1);
    type(vim, "yw");
    expect(state.text).toBe("one two");
    type(vim, "$p");
    expect(state.text).toBe("one twoone ");
  });

  it("pastes a linewise register onto its own line", () => {
    const { vim, state } = normal("one\ntwo", 0);
    type(vim, "yy");
    type(vim, "p");
    expect(state.text).toBe("one\none\ntwo");
    type(vim, "P");
    expect(state.text).toBe("one\none\none\ntwo");
  });

  it("takes the rest of the line with the capital operators", () => {
    // Escape steps back one, so 5 puts the caret on the "t".
    const deleted = normal("one two", 5);
    type(deleted.vim, "D");
    expect(deleted.state.text).toBe("one ");

    const changed = normal("one two", 5);
    type(changed.vim, "C");
    expect(changed.state.text).toBe("one ");
    expect(changed.vim.currentMode().name).toBe("insert");
  });

  it("deletes up to and through a found character", () => {
    const through = normal("ab.c", 1);
    type(through.vim, "df.");
    expect(through.state.text).toBe("c");

    const upTo = normal("ab.c", 1);
    type(upTo.vim, "dt.");
    expect(upTo.state.text).toBe(".c");

    // `t` cannot move when the caret already sits just before the target, so
    // there is no span and the draft is left alone.
    const stuck = normal("a.b", 1);
    type(stuck.vim, "dt.");
    expect(stuck.state.text).toBe("a.b");
  });

  it("runs the standalones", () => {
    const removed = normal("abc", 1);
    type(removed.vim, "x");
    expect(removed.state.text).toBe("bc");
    type(removed.vim, "2x");
    expect(removed.state.text).toBe("");

    const flipped = normal("abc", 1);
    type(flipped.vim, "3~");
    expect(flipped.state.text).toBe("ABC");

    const replaced = normal("abc", 1);
    type(replaced.vim, "rz");
    expect(replaced.state.text).toBe("zbc");

    const joined = normal("one\n  two", 1);
    type(joined.vim, "J");
    expect(joined.state.text).toBe("one two");
  });

  it("shifts lines both ways", () => {
    const { vim, state } = normal("one\ntwo", 0);
    type(vim, ">>");
    expect(state.text).toBe("  one\ntwo");
    type(vim, "<<");
    expect(state.text).toBe("one\ntwo");
  });

  it("opens a line and enters insert", () => {
    const below = normal("one\ntwo", 0);
    type(below.vim, "o");
    expect(below.state.text).toBe("one\n\ntwo");
    expect(below.vim.currentMode().name).toBe("insert");

    const above = normal("one\ntwo", 0);
    type(above.vim, "O");
    expect(above.state.text).toBe("\none\ntwo");
  });

  it("rewinds through the host's undo", () => {
    const { vim, state } = normal("one two", 1);
    type(vim, "dw");
    expect(state.text).toBe("two");
    type(vim, "u");
    expect(state.text).toBe("one two");
  });

  it("abandons an operator on a key that is not a motion", () => {
    const { vim, state } = normal("one two", 1);
    type(vim, "dz");
    expect(state.text).toBe("one two");
    // The operator is gone, so the next `w` is a plain motion.
    type(vim, "w");
    expect(state.caret).toBe(4);
  });
});

describe("vim session — text objects", () => {
  function normal(text: string, caret: number) {
    const made = session(text, caret, ENABLED);
    made.vim.handleKey(ESCAPE);
    return made;
  }

  it("takes a word inner and around", () => {
    const inner = normal("one two three", 5);
    type(inner.vim, "diw");
    expect(inner.state.text).toBe("one  three");

    const around = normal("one two three", 5);
    type(around.vim, "daw");
    expect(around.state.text).toBe("one three");
  });

  it("takes the blanks before a word that ends the line", () => {
    const { vim, state } = normal("one two", 6);
    type(vim, "daw");
    expect(state.text).toBe("one");
  });

  it("takes a quoted run from anywhere before its close", () => {
    const inside = normal('say "hello" now', 7);
    type(inside.vim, 'di"');
    expect(inside.state.text).toBe('say "" now');

    const ahead = normal('say "hello" now', 1);
    type(ahead.vim, 'ci"');
    expect(ahead.state.text).toBe('say "" now');
    expect(ahead.vim.currentMode().name).toBe("insert");

    const around = normal('say "hello" now', 7);
    type(around.vim, 'da"');
    expect(around.state.text).toBe("say  now");
  });

  it("takes a bracketed run by depth", () => {
    const nested = normal("f(g(x), y)", 5);
    type(nested.vim, "di(");
    expect(nested.state.text).toBe("f(g(), y)");

    const outer = normal("f(g(x), y)", 2);
    type(outer.vim, "di(");
    expect(outer.state.text).toBe("f()");

    const around = normal("f(g(x), y)", 5);
    type(around.vim, "da(");
    expect(around.state.text).toBe("f(g, y)");
  });

  it("names the round and curly pairs by their spoken keys", () => {
    const round = normal("f(x)", 3);
    type(round.vim, "dib");
    expect(round.state.text).toBe("f()");

    const curly = normal("a{b}c", 3);
    type(curly.vim, "diB");
    expect(curly.state.text).toBe("a{}c");
  });

  it("leaves the draft alone with no enclosing object", () => {
    const { vim, state } = normal("plain text", 1);
    type(vim, "di(");
    expect(state.text).toBe("plain text");
    // The operator is spent, so a following `w` is a plain motion again.
    type(vim, "w");
    expect(state.caret).toBe(6);
  });

  it("keeps i and a as insert entries when no operator is waiting", () => {
    const { vim, state } = normal("one two", 1);
    type(vim, "i");
    expect(vim.currentMode().name).toBe("insert");
    expect(state.text).toBe("one two");
  });

  it("yanks an object and pastes it", () => {
    const { vim, state } = normal("f(inner) tail", 3);
    type(vim, "yi(");
    expect(state.text).toBe("f(inner) tail");
    type(vim, "$p");
    expect(state.text).toBe("f(inner) tailinner");
  });
});

describe("vim session — visual", () => {
  function normal(text: string, caret: number) {
    const made = session(text, caret, ENABLED);
    made.vim.handleKey(ESCAPE);
    return made;
  }

  it("selects from the anchor and covers the caret's own grapheme", () => {
    const { vim } = normal("abcdef", 1);
    type(vim, "v");
    expect(vim.selection()).toEqual({ start: 0, end: 1 });
    type(vim, "ll");
    expect(vim.selection()).toEqual({ start: 0, end: 3 });
    expect(vim.currentMode()).toEqual({ name: "visual", span: "characterwise" });
  });

  it("covers whole lines when linewise", () => {
    const { vim } = normal("one\ntwo\nthree", 0);
    type(vim, "V");
    expect(vim.selection()).toEqual({ start: 0, end: 4 });
    type(vim, "j");
    expect(vim.selection()).toEqual({ start: 0, end: 8 });
  });

  it("toggles the span and leaves on the same key", () => {
    const { vim } = normal("abc", 1);
    type(vim, "v");
    type(vim, "V");
    expect(vim.currentMode()).toEqual({ name: "visual", span: "linewise" });
    type(vim, "V");
    expect(vim.currentMode().name).toBe("normal");
    expect(vim.selection()).toBeNull();
  });

  it("swaps the ends so the other edge can move", () => {
    const { vim, state } = normal("abcdef", 1);
    type(vim, "vll");
    expect(state.caret).toBe(2);
    type(vim, "o");
    expect(state.caret).toBe(0);
    type(vim, "h");
    // The anchor is now the far end, so moving left cannot shrink past it.
    expect(vim.selection()).toEqual({ start: 0, end: 3 });
  });

  it("deletes the selection and leaves the mode", () => {
    const { vim, state } = normal("abcdef", 1);
    type(vim, "vlld");
    expect(state.text).toBe("def");
    expect(vim.currentMode().name).toBe("normal");
  });

  it("changes the selection into insert", () => {
    const { vim, state } = normal("abcdef", 1);
    type(vim, "vlc");
    expect(state.text).toBe("cdef");
    expect(vim.currentMode().name).toBe("insert");
  });

  it("yanks the selection and pastes over another", () => {
    const { vim, state } = normal("abc def", 1);
    type(vim, "vlly");
    expect(state.text).toBe("abc def");
    // The caret returned to the span's start; select the tail and paste over it.
    type(vim, "$vhh");
    type(vim, "p");
    expect(state.text).toBe("abc abc");
  });

  it("replaces every selected grapheme", () => {
    const { vim, state } = normal("abcdef", 1);
    type(vim, "vllrz");
    expect(state.text).toBe("zzzdef");
    expect(vim.currentMode().name).toBe("normal");
  });

  it("flips the case of the selection", () => {
    const { vim, state } = normal("abcdef", 1);
    type(vim, "vll~");
    expect(state.text).toBe("ABCdef");
  });

  it("shifts the selected lines", () => {
    const { vim, state } = normal("one\ntwo", 0);
    type(vim, "Vj>");
    expect(state.text).toBe("  one\n  two");
  });

  it("widens the selection to a text object", () => {
    const { vim, state } = normal("say (inner) now", 6);
    type(vim, "vi(");
    expect(vim.selection()).toEqual({ start: 5, end: 10 });
    type(vim, "d");
    expect(state.text).toBe("say () now");
  });

  it("leaves visual on escape, then yields the next one", () => {
    const { vim } = normal("abc", 1);
    type(vim, "v");
    expect(vim.handleKey(ESCAPE)).toBe(true);
    expect(vim.currentMode().name).toBe("normal");
    expect(vim.handleKey(ESCAPE)).toBe(false);
  });

  it("announces the span it is in", () => {
    const { vim } = normal("abc", 1);
    type(vim, "v");
    expect(vim.indicatorMode()).toEqual({ name: "visual", span: "characterwise" });
    type(vim, "V");
    expect(vim.indicatorMode()).toEqual({ name: "visual", span: "linewise" });
  });
});

describe("vim session — dot repeat", () => {
  function normal(text: string, caret: number) {
    const made = session(text, caret, ENABLED);
    made.vim.handleKey(ESCAPE);
    return made;
  }

  it("replays a delete at the caret's new place", () => {
    const { vim, state } = normal("one two three", 1);
    type(vim, "dw");
    expect(state.text).toBe("two three");
    type(vim, ".");
    expect(state.text).toBe("three");
  });

  it("replays a standalone with its count", () => {
    const { vim, state } = normal("abcdefgh", 1);
    type(vim, "2x");
    expect(state.text).toBe("cdefgh");
    type(vim, ".");
    expect(state.text).toBe("efgh");
  });

  it("lets a new count replace the recorded one", () => {
    const { vim, state } = normal("abcdefgh", 1);
    type(vim, "2x");
    expect(state.text).toBe("cdefgh");
    type(vim, "3.");
    expect(state.text).toBe("fgh");
  });

  it("replays a change with what was typed into it", () => {
    const { vim, state } = normal("one two", 1);
    type(vim, "cw");
    expect(vim.currentMode().name).toBe("insert");
    // Insert is the prompt's own path, so typing is simulated on the buffer.
    state.text = `X${state.text}`;
    state.caret = 1;
    vim.handleKey(ESCAPE);
    expect(state.text).toBe("X two");

    type(vim, "w");
    type(vim, ".");
    expect(state.text).toBe("X X");
    expect(vim.currentMode().name).toBe("normal");
  });

  it("replays a text object", () => {
    const { vim, state } = normal("f(a) g(b)", 3);
    type(vim, "di(");
    expect(state.text).toBe("f() g(b)");
    type(vim, "$hh");
    type(vim, ".");
    expect(state.text).toBe("f() g()");
  });

  it("replays a visual command as the same shape somewhere new", () => {
    const { vim, state } = normal("abcdefghij", 1);
    type(vim, "vlld");
    expect(state.text).toBe("defghij");
    type(vim, ".");
    expect(state.text).toBe("ghij");
    expect(vim.currentMode().name).toBe("normal");
  });

  it("replays a linewise delete", () => {
    const { vim, state } = normal("a\nb\nc\nd", 0);
    type(vim, "dd");
    expect(state.text).toBe("b\nc\nd");
    type(vim, ".");
    expect(state.text).toBe("c\nd");
  });

  it("does nothing before any change", () => {
    const { vim, state } = normal("abc", 1);
    type(vim, ".");
    expect(state.text).toBe("abc");
  });

  it("does not record a motion, so the last change survives it", () => {
    const { vim, state } = normal("one two three", 1);
    type(vim, "x");
    expect(state.text).toBe("ne two three");
    type(vim, "www");
    // Three words on from the start is the last grapheme, so that is what goes.
    type(vim, ".");
    expect(state.text).toBe("ne two thre");
  });
});

describe("vim session — a burst of keys", () => {
  function normal(text: string, caret: number) {
    const made = session(text, caret, ENABLED, 80);
    made.vim.handleKey(ESCAPE);
    return made;
  }

  it("acts on each character when several arrive together", () => {
    const { vim, state } = normal("one two three", 1);
    // Typing fast enough delivers one event carrying the whole command.
    expect(vim.handleKey(key("0dw"))).toBe(true);
    expect(state.text).toBe("two three");
  });

  it("takes a burst that carries a count", () => {
    const { vim, state } = normal("abcdefgh", 1);
    vim.handleKey(key("3x"));
    expect(state.text).toBe("defgh");
  });

  it("takes a burst that enters and acts in visual", () => {
    const { vim, state } = normal("abcdefgh", 1);
    vim.handleKey(key("vlld"));
    expect(state.text).toBe("defgh");
    expect(vim.currentMode().name).toBe("normal");
  });

  it("leaves a burst alone in insert, where it is one insertion", () => {
    const { vim } = session("", 0, ENABLED);
    expect(vim.handleKey(key("abc"))).toBe(false);
  });
});
