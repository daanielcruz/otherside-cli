import { describe, expect, test } from "bun:test";
import {
  characterClassAt,
  displayLineDown,
  displayLineUp,
  findInLine,
  lineEnd,
  lineFirstNonBlank,
  lineStart,
  logicalLineDown,
  logicalLineUp,
  wordEndForward,
  wordStartBackward,
  wordStartForward,
} from "@/ui/input/vim/boundaries.ts";

// A ZWJ family emoji: several code points that must never be split.
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

describe("characterClassAt", () => {
  test("separates word, punctuation and blank", () => {
    const text = "a1_ .\t";
    expect(characterClassAt(text, 0)).toBe("word");
    expect(characterClassAt(text, 1)).toBe("word");
    expect(characterClassAt(text, 2)).toBe("word");
    expect(characterClassAt(text, 3)).toBe("blank");
    expect(characterClassAt(text, 4)).toBe("punctuation");
    expect(characterClassAt(text, 5)).toBe("blank");
  });

  test("a newline is blank and anything outside the buffer reads as blank", () => {
    expect(characterClassAt("a\nb", 1)).toBe("blank");
    expect(characterClassAt("abc", 3)).toBe("blank");
    expect(characterClassAt("abc", -1)).toBe("blank");
    expect(characterClassAt("", 0)).toBe("blank");
  });

  test("accented letters classify as word", () => {
    expect(characterClassAt("ção", 0)).toBe("word");
    expect(characterClassAt("ção", 1)).toBe("word");
  });
});

describe("wordStartForward", () => {
  test("crosses the current run and the blanks in front of it", () => {
    expect(wordStartForward("foo bar", 0, "small")).toBe(4);
    expect(wordStartForward("foo bar", 1, "small")).toBe(4);
    expect(wordStartForward("foo   bar", 0, "small")).toBe(6);
  });

  test("a caret on a blank only crosses the blanks", () => {
    expect(wordStartForward("foo  bar", 3, "small")).toBe(5);
  });

  test("a punctuation run is its own word for small, invisible for big", () => {
    expect(wordStartForward("foo.bar", 0, "small")).toBe(3);
    expect(wordStartForward("foo.bar", 3, "small")).toBe(4);
    expect(wordStartForward("foo.bar", 0, "big")).toBe(7);
    expect(wordStartForward("foo.bar baz", 0, "big")).toBe(8);
  });

  test("runs out at the end of the buffer and tolerates an offset past it", () => {
    expect(wordStartForward("foo", 0, "small")).toBe(3);
    expect(wordStartForward("foo", 3, "small")).toBe(3);
    expect(wordStartForward("foo", 99, "small")).toBe(3);
    expect(wordStartForward("", 0, "small")).toBe(0);
  });

  test("whitespace-only text has no next run", () => {
    expect(wordStartForward("   \t ", 0, "small")).toBe(5);
  });

  test("crosses a newline, which is just another blank", () => {
    expect(wordStartForward("foo\nbar", 0, "small")).toBe(4);
  });
});

describe("wordStartBackward", () => {
  test("returns the current run's own start when the caret sits past it", () => {
    expect(wordStartBackward("foo bar", 6, "small")).toBe(4);
    expect(wordStartBackward("foo bar", 2, "small")).toBe(0);
  });

  test("skips back over blanks to the previous run", () => {
    expect(wordStartBackward("foo bar", 4, "small")).toBe(0);
    expect(wordStartBackward("foo   bar", 6, "small")).toBe(0);
  });

  test("a punctuation run is its own word for small, invisible for big", () => {
    expect(wordStartBackward("foo.bar", 7, "small")).toBe(4);
    expect(wordStartBackward("foo.bar", 4, "small")).toBe(3);
    expect(wordStartBackward("foo.bar", 7, "big")).toBe(0);
  });

  test("runs out at offset zero", () => {
    expect(wordStartBackward("foo", 0, "small")).toBe(0);
    expect(wordStartBackward("   foo", 2, "small")).toBe(0);
    expect(wordStartBackward("", 0, "small")).toBe(0);
  });
});

describe("wordEndForward", () => {
  test("lands on the run's last grapheme, not past it", () => {
    expect(wordEndForward("foo bar", 0, "small")).toBe(2);
    expect(wordEndForward("foo bar", 1, "small")).toBe(2);
  });

  test("a caret already on a run's end moves on to the next run's end", () => {
    expect(wordEndForward("foo bar", 2, "small")).toBe(6);
  });

  test("is a different question from where the next run starts", () => {
    const text = "foo bar";
    expect(wordStartForward(text, 0, "small")).toBe(4);
    expect(wordEndForward(text, 0, "small")).toBe(2);
  });

  test("small stops at a punctuation run, big swallows it", () => {
    expect(wordEndForward("foo.bar", 0, "small")).toBe(2);
    expect(wordEndForward("foo.bar", 2, "small")).toBe(3);
    expect(wordEndForward("foo.bar", 0, "big")).toBe(6);
  });

  test("clamps to the last grapheme at the end of the buffer", () => {
    expect(wordEndForward("foo", 2, "small")).toBe(2);
    expect(wordEndForward("foo", 99, "small")).toBe(2);
    expect(wordEndForward("", 0, "small")).toBe(0);
  });
});

describe("word motions over multi-codepoint graphemes", () => {
  test("never land inside a cluster", () => {
    const text = `a ${FAMILY} b`;
    const clusterStart = 2;
    expect(wordStartForward(text, 0, "small")).toBe(clusterStart);
    expect(wordStartForward(text, clusterStart, "small")).toBe(clusterStart + FAMILY.length + 1);
    expect(wordStartBackward(text, clusterStart + FAMILY.length + 1, "small")).toBe(clusterStart);
    expect(wordEndForward(text, 0, "small")).toBe(clusterStart);
  });

  test("a cluster is one grapheme, so its class is read once", () => {
    expect(characterClassAt(FAMILY, 0)).toBe("punctuation");
  });
});

describe("line boundaries", () => {
  const text = "  first\nsecond\n";

  test("start and end bracket the caret's logical line", () => {
    expect(lineStart(text, 3)).toBe(0);
    expect(lineEnd(text, 3)).toBe(7);
    expect(lineStart(text, 9)).toBe(8);
    expect(lineEnd(text, 9)).toBe(14);
  });

  test("the first non-blank skips indentation", () => {
    expect(lineFirstNonBlank(text, 0)).toBe(2);
    expect(lineFirstNonBlank(text, 6)).toBe(2);
  });

  test("a blank line's first non-blank is its end", () => {
    expect(lineFirstNonBlank("a\n   \nb", 2)).toBe(5);
    expect(lineFirstNonBlank("a\n\nb", 2)).toBe(2);
  });

  test("offsets outside the buffer clamp", () => {
    expect(lineStart(text, 999)).toBe(15);
    expect(lineEnd(text, -5)).toBe(7);
  });
});

describe("logical line movement", () => {
  test("keeps the display column and clamps to a shorter line", () => {
    const text = "aaaa\nbb";
    expect(logicalLineDown(text, 2)).toBe(7);
    expect(logicalLineUp(text, 6)).toBe(1);
  });

  test("returns null at the first and last logical line", () => {
    const text = "one\ntwo";
    expect(logicalLineUp(text, 1)).toBeNull();
    expect(logicalLineDown(text, 5)).toBeNull();
  });

  test("a wide grapheme counts by display width, not by code units", () => {
    // The CJK character occupies two columns, so column 2 on the line below is
    // the offset right after it.
    const text = "漢x\nabcd";
    expect(logicalLineDown(text, 1)).toBe(5);
  });
});

describe("display line movement", () => {
  // promptWrapWidth subtracts a 4-cell margin, so 8 columns wrap at 4 cells.
  const columns = 8;

  test("walks wrapped rows inside one logical line where the logical motion cannot", () => {
    const text = "abcdefgh";
    expect(displayLineDown(text, 1, columns)).toBe(5);
    expect(logicalLineDown(text, 1)).toBeNull();
  });

  test("climbs back to the row above", () => {
    const text = "abcdefgh";
    expect(displayLineUp(text, 5, columns)).toBe(1);
  });

  test("returns null past the first and last row", () => {
    const text = "abcdefgh";
    expect(displayLineUp(text, 1, columns)).toBeNull();
    expect(displayLineDown(text, 5, columns)).toBeNull();
  });
});

describe("findInLine", () => {
  const text = "foo bar foo";

  test("forward search starts strictly past the caret", () => {
    expect(findInLine(text, 0, "b", "forward", "on")).toBe(4);
    expect(findInLine(text, 0, "f", "forward", "on")).toBe(8);
    expect(findInLine(text, 8, "f", "forward", "on")).toBeNull();
  });

  test("backward search starts strictly before the caret", () => {
    expect(findInLine(text, 10, "b", "backward", "on")).toBe(4);
    expect(findInLine(text, 4, "b", "backward", "on")).toBeNull();
  });

  test("a before-stop lands one grapheme short, on the approach side", () => {
    expect(findInLine(text, 0, "b", "forward", "before")).toBe(3);
    expect(findInLine(text, 10, "b", "backward", "before")).toBe(5);
  });

  test("a before-stop that cannot move reports no match", () => {
    expect(findInLine("ab", 0, "b", "forward", "before")).toBeNull();
    expect(findInLine("ab", 1, "a", "backward", "before")).toBeNull();
  });

  test("never crosses a newline", () => {
    expect(findInLine("ab\ncb", 0, "c", "forward", "on")).toBeNull();
    expect(findInLine("ab\ncb", 4, "a", "backward", "on")).toBeNull();
  });

  test("no match and an empty target report null", () => {
    expect(findInLine(text, 0, "z", "forward", "on")).toBeNull();
    expect(findInLine(text, 0, "", "forward", "on")).toBeNull();
    expect(findInLine("", 0, "a", "forward", "on")).toBeNull();
  });

  test("matches a multi-codepoint grapheme as one character", () => {
    const withCluster = `a${FAMILY}b`;
    expect(findInLine(withCluster, 0, FAMILY, "forward", "on")).toBe(1);
    expect(findInLine(withCluster, withCluster.length, FAMILY, "backward", "on")).toBe(1);
  });
});
