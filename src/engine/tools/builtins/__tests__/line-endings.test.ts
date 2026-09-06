import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { Edit } from "../edit/edit.ts";
import { clearReadStateForScope, readSetInsert, readState } from "../read/state.ts";
import { Write } from "../write.ts";

let root: string;
let ctx: RequestContext;
let scope: string;
let callId: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otherside-line-endings-"));
  scope = `line-endings-${root}`;
  ctx = {
    sessionId: scope,
    cwd: root,
    parentThreadId: scope,
    agentOwnerId: scope,
  } as unknown as RequestContext;
  callId = 0;
});

afterEach(() => {
  clearReadStateForScope(scope);
  rmSync(root, { recursive: true, force: true });
});

function edit(filePath: string, oldString: string, newString: string): Promise<ToolResult> {
  callId += 1;
  return Edit.run(
    {
      id: `edit-${callId}`,
      name: "Edit",
      input: { file_path: filePath, old_string: oldString, new_string: newString },
    },
    ctx,
  );
}

function advanceMtime(filePath: string): void {
  const timestamp = readState(scope, filePath)?.timestamp;
  if (timestamp === undefined) throw new Error("missing read state");
  const advanced = new Date(timestamp + 2_000);
  utimesSync(filePath, advanced, advanced);
}

describe("line-ending read-state consistency", () => {
  it("allows a second Edit on a CRLF file without another Read", async () => {
    const filePath = join(root, "edit-crlf.txt");
    const initialContent = "alpha\r\nomega\r\n";
    writeFileSync(filePath, initialContent);
    readSetInsert(scope, filePath, initialContent);

    const first = await edit(filePath, "alpha", "ALPHA\nBETA");
    expect(first.is_error).toBeUndefined();
    expect(readFileSync(filePath, "utf8")).toBe("ALPHA\r\nBETA\r\nomega\r\n");

    // Exercise the content comparison even when metadata changes without a content change.
    advanceMtime(filePath);
    const second = await edit(filePath, "omega", "OMEGA");

    expect(second.is_error).toBeUndefined();
    const diskContent = readFileSync(filePath, "utf8");
    expect(diskContent).toBe("ALPHA\r\nBETA\r\nOMEGA\r\n");
    expect(readState(scope, filePath)?.content).toBe(diskContent);
  });

  it("keeps Write state aligned with a CRLF file for a subsequent Edit", async () => {
    const filePath = join(root, "write-crlf.txt");
    const initialContent = "before\r\ncontent\r\n";
    writeFileSync(filePath, initialContent);
    readSetInsert(scope, filePath, initialContent);

    const writeResult = await Write.run(
      {
        id: "write-1",
        name: "Write",
        input: { file_path: filePath, content: "after\ncontent\n" },
      },
      ctx,
    );

    expect(writeResult.is_error).toBeUndefined();
    const diskContent = readFileSync(filePath, "utf8");
    expect(diskContent).toBe("after\r\ncontent\r\n");
    expect(readState(scope, filePath)?.content).toBe(diskContent);

    advanceMtime(filePath);
    const editResult = await edit(filePath, "content", "updated");

    expect(editResult.is_error).toBeUndefined();
    expect(readFileSync(filePath, "utf8")).toBe("after\r\nupdated\r\n");
  });
});
