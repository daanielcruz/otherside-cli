import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatNumberedLines, numberLinesFromStream } from "@/engine/tools/builtins/read/read.ts";

const dir = mkdtempSync(join(tmpdir(), "read-stream-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeLines(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

describe("numberLinesFromStream", () => {
  test("matches formatNumberedLines for the same range", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line number ${i + 1}`);
    const path = writeLines("plain.txt", lines);
    const streamed = await numberLinesFromStream(path, { offset: 50, limit: 20 });
    const inMemory = formatNumberedLines(`${lines.join("\n")}\n`, { offset: 50, limit: 20 });
    expect(streamed.output).toBe(inMemory.output);
    expect(streamed.rawContent).toBe(inMemory.rawContent);
    expect(streamed.emitted).toBe(inMemory.emitted);
    expect(streamed.totalLines).toBe(inMemory.totalLines);
  });

  test("counts total lines past the requested range", async () => {
    const path = writeLines("tail.txt", ["a", "b", "c", "d", "e"]);
    const result = await numberLinesFromStream(path, { offset: 1, limit: 2 });
    expect(result.emitted).toBe(2);
    expect(result.totalLines).toBe(5);
    expect(result.output).toBe("2\tb\n3\tc");
  });

  test("offset beyond the file emits nothing but reports totals", async () => {
    const path = writeLines("short.txt", ["only", "two"]);
    const result = await numberLinesFromStream(path, { offset: 10, limit: 5 });
    expect(result.emitted).toBe(0);
    expect(result.totalLines).toBe(2);
  });

  test("an oversized single line is truncated, not retained", async () => {
    const monster = "x".repeat(50_000);
    const path = writeLines("monster.txt", ["before", monster, "after"]);
    const result = await numberLinesFromStream(path, { offset: 0, limit: 10 });
    expect(result.totalLines).toBe(3);
    const monsterLine = result.output.split("\n")[1] ?? "";
    expect(monsterLine.length).toBeLessThan(2100);
    expect(monsterLine.endsWith("…")).toBe(true);
  });

  test("a file without a trailing newline keeps its last line", async () => {
    const path = join(dir, "no-newline.txt");
    writeFileSync(path, "first\nlast");
    const result = await numberLinesFromStream(path, { offset: 0, limit: 10 });
    expect(result.totalLines).toBe(2);
    expect(result.output).toBe("1\tfirst\n2\tlast");
  });
});
