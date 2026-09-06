import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMethodTable, invoke } from "@/design/bridge/dispatch.ts";
import { DesignCreateCapability } from "@/design/capabilities/create.ts";
import { DesignDeleteCapability } from "@/design/capabilities/delete.ts";
import { DesignDuplicateCapability } from "@/design/capabilities/duplicate.ts";
import { DesignFileDeleteCapability } from "@/design/capabilities/file-delete.ts";
import { LlmStreamCapability } from "@/design/capabilities/llm-stream.ts";
import { ModelSetCapability } from "@/design/capabilities/model-set.ts";
import { DesignOpenCapability } from "@/design/capabilities/open.ts";
import { DesignRenameCapability } from "@/design/capabilities/rename.ts";
import { DesignSaveCapability } from "@/design/capabilities/storage.ts";
import { DesignUploadCapability } from "@/design/capabilities/upload.ts";
import { createDesignSnapshot } from "@/design/snapshot.ts";
import { saveDesignSnapshot } from "@/design/storage.ts";
import type { JsonRpcResponse, RpcContext } from "@/design/types.ts";

const TABLE = buildMethodTable([
  DesignCreateCapability,
  DesignDeleteCapability,
  DesignDuplicateCapability,
  DesignFileDeleteCapability,
  DesignOpenCapability,
  DesignRenameCapability,
  DesignSaveCapability,
  DesignUploadCapability,
  LlmStreamCapability,
  ModelSetCapability,
]);

let configRoot: string;
let originalConfigRoot: string | undefined;

beforeEach(() => {
  originalConfigRoot = process.env.OTHERSIDE_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "otherside-design-scope-"));
  process.env.OTHERSIDE_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (originalConfigRoot === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = originalConfigRoot;
  rmSync(configRoot, { recursive: true, force: true });
});

function harness() {
  const cwd = join(configRoot, "project");
  const first = createDesignSnapshot({ designId: "design-1" });
  const second = createDesignSnapshot({ designId: "design-2" });
  saveDesignSnapshot(cwd, first);
  saveDesignSnapshot(cwd, second);
  const sent: JsonRpcResponse[] = [];
  const ctx = {
    cwd,
    codebaseRoot: cwd,
    designId: "design-1",
    activeDesignId: "design-1",
    snapshots: new Map([
      [first.designId, first],
      [second.designId, second],
    ]),
    broker: {
      read: () => ({ provider: "anthropic", model: "test", effort: null }),
    },
    send: (frame: JsonRpcResponse) => {
      sent.push(frame);
    },
    emit: () => {},
  } as unknown as RpcContext;
  return { ctx, sent };
}

async function call(
  ctx: RpcContext,
  sent: JsonRpcResponse[],
  method: string,
  params: unknown,
): Promise<JsonRpcResponse> {
  sent.length = 0;
  await invoke(TABLE, method, params, ctx, 1);
  const response = sent[0];
  if (!response) throw new Error(`${method} did not respond`);
  return response;
}

describe("active Design write scope", () => {
  test("hard-denies mutations and turns for a design that is not open", async () => {
    const { ctx, sent } = harness();
    const attempts: Array<[string, unknown, string]> = [
      ["design.rename", { designId: "design-2", title: "Changed" }, "designId is not open"],
      ["design.save", { designId: "design-2", doc: "<h1>Changed</h1>" }, "designId is not open"],
      ["model.set", { designId: "design-2", modelId: "other" }, "designId is not open"],
      [
        "design.upload",
        { designId: "design-2", name: "x.png", dataUrl: "data:image/png;base64,eA==" },
        "designId is not open",
      ],
      ["design.delete", { designId: "design-2" }, "designId is not open"],
      [
        "design.file.delete",
        { designId: "design-2", path: "design.os.html" },
        "designId is not open",
      ],
      [
        "design.duplicate",
        { sourceDesignId: "design-2", newDesignId: "design-3" },
        "sourceDesignId is not open",
      ],
      [
        "llm.stream",
        { designId: "design-2", messages: [{ role: "user", content: "Change it" }] },
        "designId is not open",
      ],
    ];

    for (const [method, params, message] of attempts) {
      const response = await call(ctx, sent, method, params);
      expect(response).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message },
      });
    }
    expect(ctx.snapshots.has("design-2")).toBe(true);
  });

  test("create and open are the only scope transitions", async () => {
    const { ctx, sent } = harness();

    await call(ctx, sent, "design.create", { designId: "design-3" });
    expect(ctx.activeDesignId).toBe("design-3");

    await call(ctx, sent, "design.open", { designId: "design-2" });
    expect(ctx.activeDesignId).toBe("design-2");
  });
});
