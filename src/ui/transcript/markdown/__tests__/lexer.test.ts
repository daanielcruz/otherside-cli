import { afterEach, expect, it, spyOn } from "bun:test";
import { marked } from "marked";
import { lexMarkdown } from "../lexer.ts";

const markdownLexer = marked.lexer;
const markerInputs = [
  "# heading",
  "* emphasis",
  "`code`",
  "| table",
  "[link",
  "> quote",
  "- list",
  "_em",
  "~del",
];

let sequence = 0;

function uniqueMarkdown(label: string): string {
  sequence += 1;
  return `# ${label}-${sequence}`;
}

afterEach(() => {
  marked.lexer = markdownLexer;
});

it("probes exactly the first 500 UTF-16 code units", () => {
  const lexerSpy = spyOn(marked, "lexer");

  for (const marker of markerInputs) lexMarkdown(marker);
  lexMarkdown("plain\n\nparagraph");
  lexMarkdown("plain\n1. ordered");
  lexMarkdown(`${"a".repeat(499)}#`);
  const boundaryToken = lexMarkdown(`${"a".repeat(500)}#`);
  const splitSurrogateToken = lexMarkdown(`${"a".repeat(499)}😀#`);

  expect(lexerSpy).toHaveBeenCalledTimes(markerInputs.length + 3);
  expect(boundaryToken).toEqual([
    {
      type: "paragraph",
      raw: `${"a".repeat(500)}#`,
      text: `${"a".repeat(500)}#`,
      tokens: [
        {
          type: "text",
          raw: `${"a".repeat(500)}#`,
          text: `${"a".repeat(500)}#`,
        },
      ],
    },
  ]);
  expect(splitSurrogateToken[0]?.type).toBe("paragraph");
});

it("returns an exact fresh synthetic token tree for plain text", () => {
  const lexerSpy = spyOn(marked, "lexer");
  const content = "plain Unicode café 😀";
  const first = lexMarkdown(content);
  const second = lexMarkdown(content);

  expect(first).toEqual([
    {
      type: "paragraph",
      raw: content,
      text: content,
      tokens: [{ type: "text", raw: content, text: content }],
    },
  ]);
  expect(first).not.toBe(second);
  expect(first[0]).not.toBe(second[0]);
  expect(lexerSpy).not.toHaveBeenCalled();
});

it("keeps a 500-entry MRU cache and evicts the least recent token tree", () => {
  const lexerSpy = spyOn(marked, "lexer");
  const entries = Array.from({ length: 500 }, (_, index) => uniqueMarkdown(`entry-${index}`));
  const oldestTokens = lexMarkdown(entries[0] ?? "");
  for (const content of entries.slice(1)) lexMarkdown(content);

  expect(lexerSpy).toHaveBeenCalledTimes(500);
  expect(lexMarkdown(entries[0] ?? "")).toBe(oldestTokens);
  expect(lexerSpy).toHaveBeenCalledTimes(500);

  lexMarkdown(uniqueMarkdown("overflow"));
  expect(lexerSpy).toHaveBeenCalledTimes(501);

  lexMarkdown(entries[1] ?? "");
  expect(lexerSpy).toHaveBeenCalledTimes(502);
  expect(lexMarkdown(entries[0] ?? "")).toBe(oldestTokens);
});

it("preserves the short-key threshold and long-key edge collisions", () => {
  const lexerSpy = spyOn(marked, "lexer");
  const shortContent = `#${"s".repeat(4094)}`;
  const thresholdContent = `#${"t".repeat(4095)}`;
  const collisionHead = `#${"h".repeat(63)}`;
  const collisionTail = "z".repeat(64);
  const firstLong = `${collisionHead}${"a".repeat(4096 - 128)}${collisionTail}`;
  const collidingLong = `${collisionHead}${"b".repeat(4096 - 128)}${collisionTail}`;

  const shortTokens = lexMarkdown(shortContent);
  const boundaryTokens = lexMarkdown(thresholdContent);
  const collisionTokens = lexMarkdown(firstLong);

  expect(lexMarkdown(shortContent)).toBe(shortTokens);
  expect(lexMarkdown(thresholdContent)).toBe(boundaryTokens);
  expect(lexMarkdown(collidingLong)).toBe(collisionTokens);
  expect(lexerSpy).toHaveBeenCalledTimes(3);
});
