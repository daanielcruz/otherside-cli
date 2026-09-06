import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildMethodTable, invoke } from "@/design/bridge/dispatch.ts";
import { RPC_INVALID_PARAMS } from "@/design/bridge/envelope.ts";
import { DesignDeleteCapability } from "@/design/capabilities/delete.ts";
import { DesignFileDeleteCapability } from "@/design/capabilities/file-delete.ts";
import { resumableDesignId } from "@/design/launcher.ts";
import { setDesignPushHook } from "@/design/push-hook.ts";
import {
  designProjectDir,
  designStorageDir,
  isValidDesignId,
  listDesigns,
  loadDesignSnapshot,
  saveDesignSnapshot,
} from "@/design/storage.ts";
import type {
  DesignSnapshot,
  JsonRpcNotification,
  JsonRpcResponse,
  RpcContext,
} from "@/design/types.ts";

describe("design/storage", () => {
  let tempConfigDir: string;
  let originalConfigDir: string | undefined;
  const cwd = "/Users/testuser/project";

  beforeEach(() => {
    originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "otherside-test-config-"));
    process.env.OTHERSIDE_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    setDesignPushHook(null);
    if (originalConfigDir !== undefined) {
      process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("round-trips a valid snapshot", () => {
    const pushed: Array<{ cwd: string; snapshot: DesignSnapshot }> = [];
    setDesignPushHook((nextCwd, nextSnapshot) => {
      pushed.push({ cwd: nextCwd, snapshot: nextSnapshot });
    });

    const snapshot: DesignSnapshot = {
      designId: "design-1",
      messages: [
        {
          id: "m-1",
          role: "user",
          content: "Hello",
          createdAt: new Date().toISOString(),
          source: "left",
          status: "done",
        },
      ],
      files: [
        {
          path: "index.html",
          content: "<h1>Test</h1>",
          status: "generated",
          language: "html",
          kind: "html",
          displayName: "Index",
          typeLabel: "html",
          updatedAt: new Date().toISOString(),
        },
      ],
      artifacts: [
        {
          artifactId: "art-1",
          kind: "os-html",
          content: "<h1>Artifact</h1>",
          metadata: {
            path: "index.html",
            title: "Artifact Title",
            updatedAt: new Date().toISOString(),
          },
        },
      ],
      viewState: {
        activeFileTab: "index.html",
        openFiles: ["index.html"],
        activeChatId: null,
      },
      designSystem: {
        designSystemId: "default",
        isDefault: true,
      },
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      effort: "high",
      status: "completed",
      updatedAt: new Date().toISOString(),
    };

    saveDesignSnapshot(cwd, snapshot);

    const loaded = loadDesignSnapshot(cwd, "design-1");
    if (!loaded) throw new Error("snapshot did not load");
    expect(loaded.designId).toBe("design-1");
    expect(loaded.status).toBe("completed");
    expect(loaded.messages.length).toBe(1);
    expect(loaded.messages[0]?.content).toBe("Hello");
    expect(loaded.files.length).toBe(1);
    expect(loaded.files[0]?.content).toBe("<h1>Test</h1>");
    expect(loaded.artifacts.length).toBe(1);
    expect(loaded.artifacts[0]?.content).toBe("<h1>Artifact</h1>");
    expect(loaded.viewState.activeFileTab).toBe("index.html");
    expect(loaded.designSystem.designSystemId).toBe("default");
    expect(loaded.provider).toBe("anthropic");
    expect(loaded.model).toBe("claude-sonnet-4-5");
    expect(loaded.effort).toBe("high");
    expect(pushed[0]?.cwd).toBe(cwd);
    expect(pushed[0]?.snapshot.designId).toBe("design-1");

    const list = listDesigns(cwd);
    expect(list.length).toBe(1);
    expect(list[0]?.designId).toBe("design-1");
    expect(list[0]?.title).toBe("Artifact Title");
    expect(list[0]?.path).toBe("index.html");
  });

  test("restores only the latest active session association", () => {
    saveDesignSnapshot(cwd, {
      designId: "design-1",
      messages: [],
      files: [],
      artifacts: [],
      viewState: { activeFileTab: null, openFiles: [], activeChatId: null },
      designSystem: { designSystemId: "default", isDefault: true },
      status: "completed",
      updatedAt: new Date().toISOString(),
    });
    const active = {
      type: "attachment" as const,
      ts: "2026-07-21T00:00:00.000Z",
      attachment: { type: "design_session", designId: "design-1", active: true },
    };
    const inactive = {
      ...active,
      ts: "2026-07-21T00:01:00.000Z",
      attachment: { ...active.attachment, active: false },
    };

    expect(resumableDesignId([active], cwd)).toBe("design-1");
    expect(resumableDesignId([active, inactive], cwd)).toBeNull();
    expect(
      resumableDesignId(
        [
          {
            ...active,
            attachment: { ...active.attachment, designId: "missing-design" },
          },
        ],
        cwd,
      ),
    ).toBeNull();
    expect(
      resumableDesignId(
        [{ ...active, attachment: { ...active.attachment, designId: "../escape" } }],
        cwd,
      ),
    ).toBeNull();
  });

  test("deletes one file and repairs snapshot view state", async () => {
    const snapshot: DesignSnapshot = {
      designId: "design-1",
      messages: [],
      files: [
        {
          path: "Canvas.os.html",
          content: "<h1>Canvas</h1>",
          status: "generated",
          language: "html",
          kind: "html",
        },
        {
          path: "Details.os.html",
          content: "<h1>Details</h1>",
          status: "generated",
          language: "html",
          kind: "html",
        },
      ],
      artifacts: [
        {
          artifactId: "design-1:canvas-os-html",
          kind: "os-html",
          content: "<h1>Canvas</h1>",
          metadata: { path: "Canvas.os.html" },
        },
        {
          artifactId: "design-1:details-os-html",
          kind: "os-html",
          content: "<h1>Details</h1>",
          metadata: { path: "Details.os.html" },
        },
      ],
      viewState: {
        activeFileTab: "Canvas.os.html",
        openFiles: ["Canvas.os.html"],
        activeChatId: null,
      },
      designSystem: { designSystemId: "default", isDefault: true },
      status: "completed",
      updatedAt: new Date().toISOString(),
    };
    saveDesignSnapshot(cwd, snapshot);

    const sent: JsonRpcResponse[] = [];
    const emitted: JsonRpcNotification[] = [];
    const context = {
      cwd,
      designId: snapshot.designId,
      activeDesignId: snapshot.designId,
      snapshots: new Map([[snapshot.designId, snapshot]]),
      send: (frame: JsonRpcResponse) => sent.push(frame),
      emit: (frame: JsonRpcNotification) => emitted.push(frame),
    } as unknown as RpcContext;

    await invoke(
      buildMethodTable([DesignFileDeleteCapability]),
      "design.file.delete",
      { designId: snapshot.designId, path: "Canvas.os.html" },
      context,
      10,
    );

    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 10,
        result: { ok: true, path: "Canvas.os.html" },
      },
    ]);
    expect(emitted).toEqual([
      {
        jsonrpc: "2.0",
        method: "$/project-mutated",
        params: { deletedPaths: ["Canvas.os.html"] },
      },
    ]);
    const loaded = loadDesignSnapshot(cwd, snapshot.designId);
    expect(loaded?.files.map((file) => file.path)).toEqual(["Details.os.html"]);
    expect(loaded?.artifacts.map((artifact) => artifact.metadata?.path)).toEqual([
      "Details.os.html",
    ]);
    expect(loaded?.viewState).toEqual({
      activeFileTab: "Details.os.html",
      openFiles: ["Details.os.html"],
      activeChatId: null,
    });
  });

  test("returns null for non-existent or invalid snapshots", () => {
    expect(loadDesignSnapshot(cwd, "non-existent")).toBeNull();
  });

  test("confines every design path and preserves siblings on malicious delete", async () => {
    const projectDir = designProjectDir(cwd);
    const safeDir = designStorageDir(cwd, "design-1");
    expect(isValidDesignId("design-1")).toBe(true);
    expect(relative(projectDir, safeDir)).toBe("design-1");

    for (const designId of ["../victim", "a/b", "a\\b", "/absolute", "a".repeat(129)]) {
      expect(isValidDesignId(designId)).toBe(false);
      expect(() => designStorageDir(cwd, designId)).toThrow("invalid designId");
    }

    const victimDir = join(dirname(projectDir), "victim");
    const sentinel = join(victimDir, "keep.txt");
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(sentinel, "keep");
    const sent: JsonRpcResponse[] = [];
    const context = {
      cwd,
      snapshots: new Map(),
      send: (frame: JsonRpcResponse) => sent.push(frame),
    } as unknown as RpcContext;

    await invoke(
      buildMethodTable([DesignDeleteCapability]),
      "design.delete",
      { designId: "../victim" },
      context,
      9,
    );

    expect(existsSync(sentinel)).toBe(true);
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 9,
        error: { code: RPC_INVALID_PARAMS, message: "designId contains unsafe characters" },
      },
    ]);
  });
});
