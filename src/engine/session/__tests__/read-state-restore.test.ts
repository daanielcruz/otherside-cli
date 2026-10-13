import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreReadStateFromRecords } from "@/engine/session/read-state-restore.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { FILE_UNCHANGED_STUB } from "@/engine/tools/builtins/read/read.ts";
import {
  clearReadStateForScope,
  MAIN_SCOPE,
  readSetContains,
  readState,
} from "@/engine/tools/builtins/read/state.ts";

const READ_AT = "2026-09-20T12:00:00.000Z";

function call(id: string, tool: string, args: Record<string, unknown>): SessionRecord {
  return { type: "tool_call", ts: READ_AT, tool_name: tool, args, call_id: id };
}

function result(id: string, text: string, isError = false): SessionRecord {
  return { type: "tool_result", ts: READ_AT, call_id: id, result: text, is_error: isError };
}

describe("restoreReadStateFromRecords", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otherside-read-restore-"));
    clearReadStateForScope(MAIN_SCOPE);
  });

  afterEach(() => {
    clearReadStateForScope(MAIN_SCOPE);
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores a whole-file Read as the text the model saw", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;");
    restoreReadStateFromRecords([
      call("r1", "Read", { file_path: file }),
      result("r1", "1\tconst a = 1;\n2\tconst b = 2;"),
    ]);

    expect(readState(MAIN_SCOPE, file)).toEqual({
      content: "const a = 1;\nconst b = 2;",
      timestamp: Date.parse(READ_AT),
    });
  });

  it("restores Write content and the current disk view after an Edit", () => {
    const written = join(dir, "w.ts");
    const edited = join(dir, "e.ts");
    writeFileSync(edited, "after edit");
    utimesSync(edited, new Date(READ_AT), new Date(READ_AT));
    restoreReadStateFromRecords([
      call("w1", "Write", { file_path: written, content: "written" }),
      result("w1", "ok"),
      call("e1", "Edit", { file_path: edited, old_string: "a", new_string: "b" }),
      result("e1", "ok"),
    ]);

    expect(readState(MAIN_SCOPE, written)?.content).toBe("written");
    expect(readState(MAIN_SCOPE, edited)).toEqual({
      content: "after edit",
      timestamp: Date.parse(READ_AT),
    });
  });

  it("skips partial reads, failed calls, and unchanged-file stubs", () => {
    const partial = join(dir, "p.ts");
    const failed = join(dir, "f.ts");
    const stub = join(dir, "s.ts");
    restoreReadStateFromRecords([
      call("p1", "Read", { file_path: partial, offset: 10, limit: 5 }),
      result("p1", "10\tline"),
      call("f1", "Read", { file_path: failed }),
      result("f1", "File does not exist.", true),
      call("s1", "Read", { file_path: stub }),
      result("s1", FILE_UNCHANGED_STUB),
    ]);

    expect(readSetContains(MAIN_SCOPE, partial)).toBe(false);
    expect(readSetContains(MAIN_SCOPE, failed)).toBe(false);
    expect(readSetContains(MAIN_SCOPE, stub)).toBe(false);
  });
});
