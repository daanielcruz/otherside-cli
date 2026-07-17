import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { emitQueue } from "@/engine/queue/emit.ts";
import { Ink } from "@/ink";
import type { QueuedMessage } from "@/store/queue-store/index.ts";
import { QueueArea } from "@/ui/chrome/queue-area.tsx";
import { TerminalEmulator } from "@/ui/transcript/__tests__/terminal-emulator.ts";

const WIDTH = 90;

function createEmulatorStdout(term: TerminalEmulator): NodeJS.WriteStream {
  const stream = {
    get columns() {
      return term.columns;
    },
    get rows() {
      return term.rows;
    },
    isTTY: true,
    write(chunk: unknown) {
      term.write(String(chunk));
      return true;
    },
    on() {
      return stream;
    },
    off() {
      return stream;
    },
  };
  return stream as unknown as NodeJS.WriteStream;
}

function createEmulatorStdin(): NodeJS.ReadStream {
  const stream = {
    isTTY: false,
    setRawMode() {
      return stream;
    },
    on() {
      return stream;
    },
    off() {
      return stream;
    },
    resume() {
      return stream;
    },
    pause() {
      return stream;
    },
    setEncoding() {
      return stream;
    },
    unref() {
      return stream;
    },
  };
  return stream as unknown as NodeJS.ReadStream;
}

function renderQueueArea(messages: readonly QueuedMessage[], active: boolean): string {
  const term = new TerminalEmulator(WIDTH, 24);
  const ink = new Ink({
    stdout: createEmulatorStdout(term),
    stdin: createEmulatorStdin(),
    stderr: createEmulatorStdout(new TerminalEmulator(WIDTH, 24)),
    exitOnCtrlC: true,
    patchConsole: false,
  });
  try {
    ink.render(createElement(QueueArea, { messages, active }));
    ink.onRender();
    return term.visibleText().trimEnd();
  } finally {
    ink.unmount();
  }
}

function queued(id: string, text: string): QueuedMessage {
  return { id, text, expanded: text };
}

beforeEach(() => {
  emitQueue._resetForTests();
});

afterEach(() => {
  emitQueue._resetForTests();
});

describe("queue area", () => {
  test("renders queued user inputs while a turn is active", () => {
    const out = renderQueueArea(
      [queued("q1", "first queued"), queued("q2", "second queued")],
      true,
    );
    expect(out).toContain("first queued");
    expect(out).toContain("second queued");
  });

  test("renders nothing when inactive", () => {
    const out = renderQueueArea([queued("q1", "hidden while idle")], false);
    expect(out).toBe("");
  });

  // Queued background-task notifications have no promptbar surface: delivery
  // happens at a queue boundary and surfaces in the transcript. A queued item
  // must never float a row here — for ANY scope (main-deliverable, a subagent
  // owner's inventory, or suppressed) and no matter how long it sits queued.
  test("emit-queue notifications never render rows, regardless of scope", () => {
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: {
        kind: "task_notification_xml",
        text: '<task-notification>\n<summary>Agent "main scoped" finished</summary>\n</task-notification>',
        summary: 'Agent "main scoped" finished',
      },
    });
    const release = emitQueue.registerOwner("owner-1");
    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: "owner-1",
      isSubagentOwned: true,
      payload: {
        kind: "task_notification_xml",
        text: '<task-notification>\n<summary>Background command "nested shell" completed (exit code 0)</summary>\n</task-notification>',
        summary: 'Background command "nested shell" completed (exit code 0)',
      },
    });
    emitQueue.emit({
      class: "deferred_output",
      target: "none",
      payload: { kind: "task_notification_xml", text: "<task-notification/>", summary: "hidden" },
    });
    const withQueuedInput = renderQueueArea([queued("q1", "typed while busy")], true);
    expect(withQueuedInput).toContain("typed while busy");
    expect(withQueuedInput).not.toContain("finished");
    expect(withQueuedInput).not.toContain("completed");
    const idle = renderQueueArea([], true);
    expect(idle).toBe("");
    release();
    // Owner teardown promotes the inventory item to main delivery — still no
    // promptbar row; the transcript owns the surfaced notice at delivery.
    expect(renderQueueArea([], true)).toBe("");
  });
});
