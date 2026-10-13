import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Read } from "@/engine/tools/builtins/read/read.ts";
import type { ContextRoom, RequestContext } from "@/kernel/std/types/request.ts";

const dir = mkdtempSync(join(tmpdir(), "read-allow-large-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 400 KB of short lines: past the standard 256 KB size limit and the 25000-token
// limit, and about 100k tokens at four bytes a token.
const LARGE_BYTES = 400 * 1024;
const ANYWAY = "call Read again with allow_large: true";
const NO_ROOM = "Even with allow_large, this is more than fits";

function writeLarge(name: string): string {
  const path = join(dir, name);
  const line = `${"x".repeat(63)}\n`;
  writeFileSync(path, line.repeat(LARGE_BYTES / line.length));
  return path;
}

function room(threshold: number, used = 0): ContextRoom & { claimed: number } {
  const state = { claimed: 0 };
  return {
    threshold,
    used: () => used + state.claimed,
    claim: (tokens) => {
      state.claimed += tokens;
    },
    get claimed() {
      return state.claimed;
    },
  };
}

function context(contextRoom?: ContextRoom): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: null,
    sessionId: `allow-large-${crypto.randomUUID()}`,
    cwd: dir,
    permissionMode: "default",
    ...(contextRoom !== undefined ? { contextRoom } : {}),
  };
}

async function read(input: Record<string, unknown>, ctx: RequestContext) {
  return Read.run({ id: `call-${crypto.randomUUID()}`, name: "Read", input }, ctx);
}

describe("Read allow_large", () => {
  test("a file over the size limit names the size and offers allow_large when it would fit", async () => {
    const path = writeLarge("offer.txt");
    const result = await read({ file_path: path }, context(room(900_000)));

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toStartWith(
      "File content (400KB) exceeds maximum allowed size (256KB). Use offset and limit parameters",
    );
    expect(String(result.content)).toContain(ANYWAY);
  });

  test("allow_large reads past the size limit when the context has room, and claims it", async () => {
    const path = writeLarge("lifted.txt");
    const contextRoom = room(900_000);
    const result = await read({ file_path: path, allow_large: true }, context(contextRoom));

    expect(result.is_error).toBeUndefined();
    expect(result.meta).toMatchObject({ kind: "read", numLines: 2000 });
    expect(contextRoom.claimed).toBeGreaterThan(25_000);
  });

  test("allow_large still refuses what does not fit the room left, and says so", async () => {
    const path = writeLarge("no-room.txt");
    const result = await read(
      { file_path: path, allow_large: "true" },
      context(room(900_000, 870_000)),
    );

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain(NO_ROOM);
  });

  test("a read that cannot know the room keeps the standard limits and no hint", async () => {
    const path = writeLarge("unknown-room.txt");
    const result = await read({ file_path: path, allow_large: true }, context());

    expect(result.is_error).toBe(true);
    expect(String(result.content)).not.toContain("allow_large");
  });

  test("a standard read claims no room", async () => {
    const path = join(dir, "small.txt");
    writeFileSync(path, "one\ntwo\n");
    const contextRoom = room(900_000);
    await read({ file_path: path }, context(contextRoom));

    expect(contextRoom.claimed).toBe(0);
  });
});
