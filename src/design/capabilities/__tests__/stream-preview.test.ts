import { describe, expect, it } from "bun:test";
import { DesignStreamPreview, partialDesignInput } from "@/design/stream-preview.ts";
import type { DesignSnapshot, RpcContext } from "@/design/types.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";

function snapshot(files: DesignSnapshot["files"] = []): DesignSnapshot {
  return {
    designId: "design-1",
    title: "Stream test",
    messages: [],
    files,
    artifacts: [],
    viewState: {
      activeFileTab: files[0]?.path ?? null,
      openFiles: files.map((file) => file.path),
      activeChatId: null,
    },
    designSystem: { designSystemId: "default", isDefault: true },
    status: "streaming",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function harness(files: DesignSnapshot["files"] = []) {
  const notifications: unknown[] = [];
  const current = snapshot(files);
  const ctx = {
    snapshots: new Map([[current.designId, current]]),
    emit: (notification: { method: string; params?: unknown }) => notifications.push(notification),
  } as unknown as RpcContext;
  return {
    current,
    notifications,
    preview: new DesignStreamPreview(ctx, current.designId),
  };
}

function inputDelta(toolName: string, partial: string): ForkEvent {
  return {
    kind: "fork_tool_input_delta",
    forkId: "fork-1",
    toolCallId: "tool-1",
    toolName,
    partial,
  };
}

function dispatchComplete(
  isError: boolean,
): Extract<ForkEvent, { kind: "fork_tool_dispatch_complete" }> {
  return {
    kind: "fork_tool_dispatch_complete",
    forkId: "fork-1",
    toolCallId: "tool-1",
    toolName: "create_design",
    content: "",
    isError,
  };
}

describe("partial design input", () => {
  it("decodes incomplete escaped content without reading nested lookalike fields", () => {
    const content = '<script>const nested = {"path":"trap.os.html"};</script>\n<h1>Hi</h1>';
    const encoded = JSON.stringify({ path: "home.os.html", title: "Home", content });
    const parsed = partialDesignInput(encoded.slice(0, -2));

    expect(parsed.path).toEqual({ value: "home.os.html", complete: true });
    expect(parsed.title).toEqual({ value: "Home", complete: true });
    expect(parsed.content).toEqual({ value: content, complete: false });
  });
});

describe("design stream preview", () => {
  it("publishes whole-file snapshots and rolls a failed create back", () => {
    const { current, notifications, preview } = harness();
    const first = "a".repeat(160);
    const second = "b".repeat(80);

    preview.handle(inputDelta("create_design", `{"path":"home.os.html","content":"${first}`));
    preview.handle(inputDelta("create_design", second));
    preview.handle({
      kind: "fork_tool_dispatch_start",
      forkId: "fork-1",
      toolCallId: "tool-1",
      toolName: "create_design",
      input: {},
    });
    preview.handle(dispatchComplete(true));

    expect(notifications).toHaveLength(3);
    expect(notifications[0]).toMatchObject({
      method: "$/project-mutated",
      params: {
        transient: true,
        files: [{ path: "home.os.html", content: first }],
      },
    });
    expect(notifications[1]).toMatchObject({
      params: {
        transient: true,
        files: [{ path: "home.os.html", content: first + second }],
      },
    });
    expect(notifications[2]).toMatchObject({
      params: { transient: true, deletedPaths: ["home.os.html"] },
    });
    expect(current.files).toEqual([]);
  });

  it("restores an existing screen after a failed update", () => {
    const original = {
      path: "home.os.html",
      content: "<h1>Original</h1>",
      status: "unchanged" as const,
      language: "html",
      kind: "html",
      displayName: "Home",
    };
    const { notifications, preview } = harness([original]);
    const replacement = `<h1>${"Updated ".repeat(30)}</h1>`;

    preview.handle(
      inputDelta("update_design", JSON.stringify({ path: "home.os.html", content: replacement })),
    );
    preview.handle({ ...dispatchComplete(true), toolName: "update_design" });

    expect(notifications[0]).toMatchObject({
      params: { transient: true, files: [{ content: replacement }] },
    });
    expect(notifications[1]).toEqual({
      jsonrpc: "2.0",
      method: "$/project-mutated",
      params: { transient: true, files: [original] },
    });
  });

  it("discards transient bookkeeping after a successful write", () => {
    const { notifications, preview } = harness();
    const content = `<main>${"Ready".repeat(40)}</main>`;

    preview.handle(inputDelta("create_design", JSON.stringify({ path: "ready.os.html", content })));
    preview.handle(dispatchComplete(false));
    preview.rollbackAll();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      params: { transient: true, files: [{ path: "ready.os.html", content }] },
    });
  });
});
