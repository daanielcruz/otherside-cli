import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInlineRead, parseEmbeddedReadCommands } from "../inline-read-prefetch.ts";

describe("parseEmbeddedReadCommands", () => {
  it("extracts line windows from sed, head, and tail commands", () => {
    expect(parseEmbeddedReadCommands("sed -n '4,7p' notes.txt")).toEqual([
      {
        filePath: "notes.txt",
        selection: { kind: "range", firstLine: 4, lastLine: 7 },
      },
    ]);
    expect(parseEmbeddedReadCommands("sed --quiet '3p' notes.txt")).toEqual([
      {
        filePath: "notes.txt",
        selection: { kind: "range", firstLine: 3, lastLine: 3 },
      },
    ]);
    expect(parseEmbeddedReadCommands("head notes.txt")).toEqual([
      {
        filePath: "notes.txt",
        selection: { kind: "range", firstLine: 1, lastLine: 10 },
      },
    ]);
    expect(parseEmbeddedReadCommands("head --lines=6 notes.txt")).toEqual([
      {
        filePath: "notes.txt",
        selection: { kind: "range", firstLine: 1, lastLine: 6 },
      },
    ]);
    expect(parseEmbeddedReadCommands("tail -4 notes.txt")).toEqual([
      { filePath: "notes.txt", selection: { kind: "tail", count: 4 } },
    ]);
  });

  it("marks search reads as conditional on a successful command", () => {
    expect(parseEmbeddedReadCommands("grep -A 2 needle notes.txt")).toEqual([
      { filePath: "notes.txt", onlyOnSuccess: true },
    ]);
    expect(parseEmbeddedReadCommands("rg --context=2 needle notes.txt")).toEqual([
      { filePath: "notes.txt", onlyOnSuccess: true },
    ]);
  });

  it("rejects writes, streams, globs, and ambiguous line limits", () => {
    const rejected = [
      "cat notes.txt > copy.txt",
      "cat notes.txt | head -2",
      "grep needle '*.txt'",
      "head -n 0 notes.txt",
      "head -n nope notes.txt",
      "sed -i -n '3p' notes.txt",
    ];
    for (const command of rejected) expect(parseEmbeddedReadCommands(command)).toEqual([]);
  });
});

describe("loadInlineRead", () => {
  it("loads complete files and selected line windows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "otherside-inline-read-"));
    const filePath = join(directory, "notes.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n");

    try {
      await expect(loadInlineRead(filePath, { filePath }, undefined)).resolves.toEqual({
        content: "alpha\nbeta\ngamma\ndelta\n",
      });
      await expect(
        loadInlineRead(
          filePath,
          { filePath, selection: { kind: "range", firstLine: 2, lastLine: 3 } },
          undefined,
        ),
      ).resolves.toEqual({ content: "beta\ngamma", offset: 2, limit: 2 });
      await expect(
        loadInlineRead(filePath, { filePath, selection: { kind: "tail", count: 2 } }, undefined),
      ).resolves.toEqual({
        content: "gamma\ndelta",
        offset: 3,
        limit: 2,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns null when a read cannot be prefetched", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadInlineRead(join(tmpdir(), "missing-inline-read.txt"), { filePath: "unused" }, undefined),
    ).resolves.toBeNull();
    await expect(
      loadInlineRead(import.meta.path, { filePath: "unused" }, controller.signal),
    ).resolves.toBeNull();
  });
});
