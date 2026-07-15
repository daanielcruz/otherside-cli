import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designStorageDir } from "@/design/storage.ts";
import type { DesignSnapshot } from "@/design/types.ts";
import { ReadDesign } from "@/engine/tools/builtins/design/read-design.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const CWD = "/Users/testuser/project";
const DESIGN_ID = "11111111-2222-3333-4444-555555555555";

function snapshotFixture(overrides?: Partial<DesignSnapshot>): DesignSnapshot {
  return {
    designId: DESIGN_ID,
    title: "Volunteer guide",
    messages: [],
    files: [
      {
        path: "guide.os.html",
        status: "generated",
        language: "html",
        content: Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"),
      },
    ],
    artifacts: [],
    viewState: { activeFileTab: null, openFiles: [], activeChatId: null },
    designSystem: { designSystemId: "default", isDefault: true },
    provider: "minimax",
    model: "minimax-m3",
    status: "completed",
    updatedAt: "2026-07-12T21:00:00.000Z",
    ...overrides,
  };
}

function writeSnapshot(snapshot: unknown): void {
  const dir = designStorageDir(CWD, DESIGN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
}

function call(input: Record<string, unknown>): ToolCall {
  return { id: "tu-1", name: "ReadDesign", input } as ToolCall;
}

function ctx(): RequestContext {
  return { cwd: CWD } as RequestContext;
}

describe("ReadDesign", () => {
  let tempConfigDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "otherside-test-config-"));
    process.env.OTHERSIDE_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (originalConfigDir !== undefined) {
      process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("rejects a non-UUID design_id", async () => {
    const result = await ReadDesign.run(call({ design_id: "nope" }), ctx());
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("UUID");
  });

  test("returns the inventory when file_path is omitted", async () => {
    writeSnapshot(snapshotFixture());
    const result = await ReadDesign.run(call({ design_id: DESIGN_ID }), ctx());
    expect(result.is_error).toBeUndefined();
    const text = String(result.content);
    expect(text).toContain("Volunteer guide");
    expect(text).toContain("minimax / minimax-m3");
    expect(text).toContain("guide.os.html");
    expect(text).not.toContain("WARNING");
  });

  test("reads a file with pagination and truncation note", async () => {
    writeSnapshot(snapshotFixture());
    const result = await ReadDesign.run(
      call({ design_id: DESIGN_ID, file_path: "guide.os.html", offset: 2, limit: 3 }),
      ctx(),
    );
    expect(result.is_error).toBeUndefined();
    const text = String(result.content);
    expect(text).toContain("line 2");
    expect(text).toContain("line 4");
    expect(text).not.toContain("line 5");
    expect(text).toContain("[truncated: 5 more lines — continue with offset=5]");
  });

  test("reads to the end without a truncation note", async () => {
    writeSnapshot(snapshotFixture());
    const result = await ReadDesign.run(
      call({ design_id: DESIGN_ID, file_path: "guide.os.html", offset: 5 }),
      ctx(),
    );
    expect(String(result.content)).not.toContain("[truncated");
    expect(String(result.content)).toContain("line 9");
  });

  test("errors clearly when the design does not exist for this project", async () => {
    const result = await ReadDesign.run(call({ design_id: DESIGN_ID }), ctx());
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("not found for this project");
  });

  test("errors clearly on a corrupt snapshot", async () => {
    const dir = designStorageDir(CWD, DESIGN_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "snapshot.json"), "{not json");
    const result = await ReadDesign.run(call({ design_id: DESIGN_ID }), ctx());
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("corrupt");
  });

  test("flags an incomplete design but still returns content", async () => {
    writeSnapshot(snapshotFixture({ status: "streaming" }));
    const inv = await ReadDesign.run(call({ design_id: DESIGN_ID }), ctx());
    expect(inv.is_error).toBeUndefined();
    expect(String(inv.content)).toContain("WARNING: this design is incomplete");
    const read = await ReadDesign.run(
      call({ design_id: DESIGN_ID, file_path: "guide.os.html" }),
      ctx(),
    );
    expect(String(read.content)).toContain("WARNING: this design is incomplete");
    expect(String(read.content)).toContain("line 0");
  });

  test("errors with the available paths on an unknown file_path", async () => {
    writeSnapshot(snapshotFixture());
    const result = await ReadDesign.run(
      call({ design_id: DESIGN_ID, file_path: "missing.os.html" }),
      ctx(),
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("guide.os.html");
  });
});
