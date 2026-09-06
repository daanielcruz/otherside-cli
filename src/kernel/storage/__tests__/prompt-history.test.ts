import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fsModule from "node:fs";

const originalFs: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(fsModule)) {
  originalFs[key] = (fsModule as Record<string | symbol, unknown>)[key];
}

const memFiles = new Map<string, string>();
let fdCounter = 0;
const fdPaths = new Map<number, string>();

function memWrite(p: string, content: string): void {
  memFiles.set(p, content);
}

const S = "Sync";
const mockFs: Record<string, unknown> = {};
mockFs[`writeFile${S}`] = (p: string, content: string | Buffer) =>
  memFiles.set(p, typeof content === "string" ? content : content.toString("utf8"));
mockFs[`open${S}`] = (p: string) => {
  const fd = ++fdCounter;
  fdPaths.set(fd, p);
  return fd;
};
mockFs[`fstat${S}`] = (fd: number) => {
  const p = fdPaths.get(fd);
  const c = p ? (memFiles.get(p) ?? "") : "";
  return { size: Buffer.byteLength(c) };
};
mockFs[`read${S}`] = (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
  const p = fdPaths.get(fd);
  const c = p ? (memFiles.get(p) ?? "") : "";
  const fb = Buffer.from(c, "utf8");
  return fb.copy(buf, off, pos, pos + len);
};
mockFs[`close${S}`] = (fd: number) => {
  fdPaths.delete(fd);
};
mockFs[`exists${S}`] = (p: string) => memFiles.has(p);
mockFs[`mkdir${S}`] = () => {};
mockFs[`appendFile${S}`] = (p: string, content: string | Buffer) => {
  const prev = memFiles.get(p) ?? "";
  memFiles.set(p, prev + (typeof content === "string" ? content : content.toString("utf8")));
};

mock.module("node:fs", () => mockFs);

import {
  loadPromptHistoryAllProjects,
  loadPromptHistoryForCwd,
  MAX_PROMPT_HISTORY_ITEMS,
  MAX_PROMPT_SEARCH_ITEMS,
  promptHistoryPath,
} from "../prompt-history.ts";

const CWD = "/tmp/test-project-a";
const OTHER_CWD = "/tmp/test-project-b";

let prevConfigDir: string | undefined;

function writeHistory(entries: Array<{ display: string; project: string }>): void {
  const lines = entries.map((e) =>
    JSON.stringify({
      display: e.display,
      timestamp: 1700000000000,
      project: e.project,
      sessionId: "test-session",
    }),
  );
  memWrite(promptHistoryPath(), `${lines.join("\n")}\n`);
}

beforeEach(() => {
  memFiles.clear();
  fdPaths.clear();
  fdCounter = 0;
  prevConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = "/test-history-config";
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = prevConfigDir;
});

afterAll(() => {
  mock.module("node:fs", () => originalFs);
});

describe("loadPromptHistoryForCwd", () => {
  test("missing file returns empty array", () => {
    expect(loadPromptHistoryForCwd(CWD)).toEqual([]);
  });

  test("returns only entries for the current cwd", () => {
    writeHistory([
      { display: "a-one", project: CWD },
      { display: "b-one", project: OTHER_CWD },
      { display: "a-two", project: CWD },
      { display: "b-two", project: OTHER_CWD },
    ]);
    expect(loadPromptHistoryForCwd(CWD)).toEqual(["a-one", "a-two"]);
  });

  test("preserves chronological order (oldest first)", () => {
    writeHistory([
      { display: "first", project: CWD },
      { display: "second", project: CWD },
      { display: "third", project: CWD },
    ]);
    expect(loadPromptHistoryForCwd(CWD)).toEqual(["first", "second", "third"]);
  });

  test("caps at MAX_PROMPT_HISTORY_ITEMS via early-stop on reverse scan", () => {
    const total = MAX_PROMPT_HISTORY_ITEMS + 25;
    const entries = Array.from({ length: total }, (_, i) => ({
      display: `entry-${i}`,
      project: CWD,
    }));
    writeHistory(entries);
    const loaded = loadPromptHistoryForCwd(CWD);
    expect(loaded.length).toBe(MAX_PROMPT_HISTORY_ITEMS);
    expect(loaded[0]).toBe(`entry-${total - MAX_PROMPT_HISTORY_ITEMS}`);
    expect(loaded[loaded.length - 1]).toBe(`entry-${total - 1}`);
  });

  test("ignores corrupt JSON lines without crashing", () => {
    const path = promptHistoryPath();
    const valid = JSON.stringify({
      display: "valid",
      timestamp: 1700000000000,
      project: CWD,
      sessionId: "s",
    });
    memWrite(path, `${valid}\nthis is not json\n${valid}\n`);
    expect(loadPromptHistoryForCwd(CWD)).toEqual(["valid", "valid"]);
  });

  test("works without trailing newline", () => {
    const path = promptHistoryPath();
    const a = JSON.stringify({
      display: "no-trailing-newline",
      timestamp: 1700000000000,
      project: CWD,
    });
    memWrite(path, a);
    expect(loadPromptHistoryForCwd(CWD)).toEqual(["no-trailing-newline"]);
  });

  test("filters out entries missing required fields", () => {
    const path = promptHistoryPath();
    const valid = JSON.stringify({
      display: "ok",
      timestamp: 1700000000000,
      project: CWD,
    });
    const missingDisplay = JSON.stringify({ timestamp: 1700000000000, project: CWD });
    const missingProject = JSON.stringify({ display: "x", timestamp: 1700000000000 });
    const missingTimestamp = JSON.stringify({ display: "y", project: CWD });
    memWrite(path, `${valid}\n${missingDisplay}\n${missingProject}\n${missingTimestamp}\n`);
    expect(loadPromptHistoryForCwd(CWD)).toEqual(["ok"]);
  });
});

describe("loadPromptHistoryAllProjects", () => {
  test("missing file returns empty array", () => {
    expect(loadPromptHistoryAllProjects()).toEqual([]);
  });

  test("keeps every project's entries, oldest first", () => {
    writeHistory([
      { display: "a-one", project: CWD },
      { display: "b-one", project: OTHER_CWD },
      { display: "a-two", project: CWD },
    ]);
    expect(loadPromptHistoryAllProjects()).toEqual(["a-one", "b-one", "a-two"]);
  });

  test("reaches further back than the per-project walk", () => {
    const entries = Array.from({ length: MAX_PROMPT_HISTORY_ITEMS + 20 }, (_, i) => ({
      display: `entry-${i}`,
      project: OTHER_CWD,
    }));
    writeHistory(entries);

    // The walk sees none of these — they belong to another project.
    expect(loadPromptHistoryForCwd(CWD)).toEqual([]);
    expect(loadPromptHistoryAllProjects()).toHaveLength(entries.length);
  });

  test("stops at the search window", () => {
    const entries = Array.from({ length: MAX_PROMPT_SEARCH_ITEMS + 5 }, (_, i) => ({
      display: `entry-${i}`,
      project: CWD,
    }));
    writeHistory(entries);

    const loaded = loadPromptHistoryAllProjects();
    expect(loaded).toHaveLength(MAX_PROMPT_SEARCH_ITEMS);
    // The window keeps the newest end of the store.
    expect(loaded.at(-1)).toBe(`entry-${entries.length - 1}`);
  });
});
