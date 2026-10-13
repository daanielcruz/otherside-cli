import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMethodTable, invoke } from "@/design/bridge/dispatch.ts";
import { DesignOpenCapability } from "@/design/capabilities/open.ts";
import { createDesignSnapshot } from "@/design/snapshot.ts";
import { loadDesignSnapshot, saveDesignSnapshot } from "@/design/storage.ts";
import type { DesignSnapshot, JsonRpcResponse, RpcContext } from "@/design/types.ts";

const TABLE = buildMethodTable([DesignOpenCapability]);

let configRoot: string;
let originalConfigRoot: string | undefined;

beforeEach(() => {
  originalConfigRoot = process.env.OTHERSIDE_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "otherside-design-open-"));
  process.env.OTHERSIDE_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (originalConfigRoot === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = originalConfigRoot;
  rmSync(configRoot, { recursive: true, force: true });
});

function harness(held?: DesignSnapshot) {
  const cwd = join(configRoot, "project");
  if (held) saveDesignSnapshot(cwd, held);
  const sent: JsonRpcResponse[] = [];
  const ctx = {
    cwd,
    codebaseRoot: cwd,
    designId: held?.designId ?? "none",
    activeDesignId: held?.designId ?? "none",
    snapshots: new Map(held ? [[held.designId, held]] : []),
    broker: { read: () => ({ provider: "anthropic", model: "test", effort: null }) },
    send: (frame: JsonRpcResponse) => {
      sent.push(frame);
    },
    emit: () => {},
  } as unknown as RpcContext;
  return { ctx, sent, cwd };
}

function offered(designId: string, updatedAt: string, title: string): DesignSnapshot {
  return { ...createDesignSnapshot({ designId }), title, updatedAt };
}

async function open(ctx: RpcContext, sent: JsonRpcResponse[], params: unknown) {
  sent.length = 0;
  await invoke(TABLE, "design.open", params, ctx, 1);
  const response = sent[0];
  if (!response) throw new Error("design.open did not respond");
  return response;
}

function errorMessage(response: JsonRpcResponse): string | undefined {
  return "error" in response ? response.error.message : undefined;
}

function resultSnapshot(response: JsonRpcResponse): DesignSnapshot | undefined {
  return "result" in response
    ? (response.result as { snapshot: DesignSnapshot }).snapshot
    : undefined;
}

describe("design.open with an offered snapshot", () => {
  test("adopts a design this CLI has never held", async () => {
    const { ctx, sent, cwd } = harness();
    const fromBrowser = offered("design-b", "2026-09-20T10:00:00.000Z", "From the browser");

    const response = await open(ctx, sent, { snapshot: fromBrowser });

    expect(errorMessage(response)).toBeUndefined();
    expect(loadDesignSnapshot(cwd, "design-b")?.title).toBe("From the browser");
    expect(ctx.activeDesignId).toBe("design-b");
  });

  test("replaces a held copy the browser has moved past", async () => {
    const held = offered("design-b", "2026-09-19T10:00:00.000Z", "Older here");
    const { ctx, sent, cwd } = harness(held);
    const fromBrowser = offered("design-b", "2026-09-20T10:00:00.000Z", "Newer in browser");

    await open(ctx, sent, { designId: "design-b", snapshot: fromBrowser });

    expect(loadDesignSnapshot(cwd, "design-b")?.title).toBe("Newer in browser");
    expect(ctx.snapshots.get("design-b")?.title).toBe("Newer in browser");
  });

  test("keeps a held copy that is newer than the browser's", async () => {
    const held = offered("design-b", "2026-09-21T10:00:00.000Z", "Turn ended here");
    const { ctx, sent, cwd } = harness(held);
    const fromBrowser = offered("design-b", "2026-09-20T10:00:00.000Z", "Stale in browser");

    const response = await open(ctx, sent, { designId: "design-b", snapshot: fromBrowser });

    expect(loadDesignSnapshot(cwd, "design-b")?.title).toBe("Turn ended here");
    expect(resultSnapshot(response)?.title).toBe("Turn ended here");
  });

  test("rejects a snapshot whose designId disagrees with the one named", async () => {
    const { ctx, sent } = harness();
    const response = await open(ctx, sent, {
      designId: "design-a",
      snapshot: offered("design-b", "2026-09-20T10:00:00.000Z", "x"),
    });
    expect(errorMessage(response)).toBe("snapshot belongs to a different designId");
  });

  test("rejects a snapshot that is not a design", async () => {
    const { ctx, sent } = harness();
    const response = await open(ctx, sent, { snapshot: { designId: "design-b" } });
    expect(errorMessage(response)).toBe("snapshot is not a valid design");
  });
});
