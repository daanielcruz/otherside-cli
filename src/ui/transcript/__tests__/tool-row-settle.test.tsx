import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { useEffect } from "react";
import { Box, Ink, Text } from "@/ink";
import { transcriptActions } from "@/store/index.ts";
import type { TranscriptEntry } from "../types";
import { TerminalEmulator } from "./terminal-emulator.ts";

// A tool row's transcript entry changes id across its lifecycle (running `t_…`
// → completed `r_…`) while the store replaces it in the SAME slot. The Log must
// reconcile that transition — the settle boundary — as an in-place update of the
// existing row, NOT an unmount + remount. A remount cannot rewrite the copy the
// retained frame already froze offscreen, so the stale pending row is stranded
// in the frame while the completion paints separately: the duplicated tool row.
//
// The row's real renderer is stubbed with a mount-tracked leaf so the boundary's
// reconciliation is observable directly (a remount is a defect regardless of
// whether a given terminal geometry happens to surface it as a visible double).
const mountLog: string[] = [];
function TrackedToolRow({ entry }: { entry: TranscriptEntry }): React.JSX.Element {
  const callId = entry.id.replace(/^[a-z]+_/, "");
  const phase = entry.id.startsWith("t_") ? "pending" : "done";
  useEffect(() => {
    mountLog.push(`mount:${callId}`);
    return () => {
      mountLog.push(`unmount:${callId}`);
    };
    // Empty deps: fires on true mount/unmount only, never on a content update.
  }, []);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{`TOOLROW ${callId} ${phase}`}</Text>
      {phase === "done" ? <Text>{`RESULT ${callId}`}</Text> : null}
    </Box>
  );
}
mock.module("@/ui/transcript/tool.tsx", () => ({ ToolEntryRow: TrackedToolRow }));

// Import Log only after the tool-row mock is registered.
const { Log } = await import("../blocks/log.tsx");

function createStdout(term: TerminalEmulator): NodeJS.WriteStream {
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

function createStdin(): NodeJS.ReadStream {
  const s = {
    isTTY: false,
    isRaw: false,
    setRawMode() {},
    listeners: () => [],
    addListener() {
      return s;
    },
    removeListener() {
      return s;
    },
    on() {
      return s;
    },
    off() {
      return s;
    },
  };
  return s as unknown as NodeJS.ReadStream;
}

type Harness = {
  render: (entries: readonly TranscriptEntry[]) => void;
  term: TerminalEmulator;
  cleanup: () => void;
};

function createHarness(width: number, height: number): Harness {
  const term = new TerminalEmulator(width, height);
  const stdout = createStdout(term);
  const ink = new Ink({
    stdout,
    stdin: createStdin(),
    stderr: createStdout(new TerminalEmulator(width, height)),
    exitOnCtrlC: true,
    patchConsole: false,
  });
  return {
    term,
    render(entries) {
      ink.render(
        <Box flexDirection="column" width="100%">
          <Log entries={entries} intro={null} providerShortKey="test" currentModel="model" />
          <Box flexDirection="column" flexShrink={0}>
            <Text>FOOTER_MARKER shift+tab</Text>
          </Box>
        </Box>,
      );
      ink.onRender();
    },
    cleanup() {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function turns(count: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: `u${i}`, kind: "user", text: `user message number ${i}x` });
    out.push({ id: `a${i}`, kind: "assistant", text: `assistant reply number ${i}x` });
  }
  return out;
}

const CALL_ID = "call_img_1";
const READ_ARGS = JSON.stringify({ file_path: "/tmp/screen-shot.png" });

const pendingRead: TranscriptEntry = {
  id: `t_${CALL_ID}`,
  kind: "tool",
  title: "Read",
  text: READ_ARGS,
  startedAt: Date.now(),
};

const completedImageRead: TranscriptEntry = {
  id: `r_${CALL_ID}`,
  kind: "tool",
  title: "Read",
  text: "[image: image/png 800x600]",
  isError: false,
  input: READ_ARGS,
  resultMeta: { kind: "image", bytes: 12492 },
};

const completedTextRead: TranscriptEntry = {
  id: `r_${CALL_ID}`,
  kind: "tool",
  title: "Read",
  text: JSON.stringify({ type: "text", numLines: 42 }),
  isError: false,
  input: READ_ARGS,
};

const OTHER_ID = "call_bash_2";
const pendingSibling: TranscriptEntry = {
  id: `t_${OTHER_ID}`,
  kind: "tool",
  title: "Bash",
  text: JSON.stringify({ command: "make build" }),
  startedAt: Date.now(),
};

function mountsFor(events: readonly string[], callId: string): number {
  return events.filter((e) => e === `mount:${callId}`).length;
}
function unmountsFor(events: readonly string[], callId: string): number {
  return events.filter((e) => e === `unmount:${callId}`).length;
}

let previousNodeEnv: string | undefined;

beforeEach(() => {
  previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  transcriptActions.clear();
  mountLog.length = 0;
});
afterEach(() => {
  transcriptActions.clear();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

describe("tool row settle boundary", () => {
  it("updates the row in place across run→image-completion (no remount)", async () => {
    const h = createHarness(110, 45);
    try {
      const base = turns(2);
      h.render(base);
      await settle();
      h.render([...base, pendingRead]);
      await settle();
      // Elapsed-style re-render of the SAME pending row (content changes, id
      // stays t_…): must not remount.
      h.render([...base, { ...pendingRead }]);
      await settle();
      // Completion flips t_… → r_… in the same slot: the settle boundary.
      h.render([...base, completedImageRead]);
      await settle();

      const duringDrive = [...mountLog];
      // Exactly one mount and zero unmounts before teardown → the row lived as a
      // single instance across the whole run→complete lifecycle (in place). The
      // pre-fix Log remounts here (mounts=2), stranding the frozen pending copy.
      expect({
        mounts: mountsFor(duringDrive, CALL_ID),
        unmounts: unmountsFor(duringDrive, CALL_ID),
      }).toEqual({ mounts: 1, unmounts: 0 });

      // And the completed row renders exactly once, with its result child.
      expect(h.term.countOccurrences(`TOOLROW ${CALL_ID} done`)).toBe(1);
      expect(h.term.countOccurrences(`RESULT ${CALL_ID}`)).toBe(1);
      // No stale pending copy of the row survives anywhere in the frame.
      expect(h.term.countOccurrences(`TOOLROW ${CALL_ID} pending`)).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("updates in place for a text-result completion too (no behavior change)", async () => {
    const h = createHarness(110, 45);
    try {
      const base = turns(2);
      h.render(base);
      await settle();
      h.render([...base, pendingRead]);
      await settle();
      h.render([...base, completedTextRead]);
      await settle();

      const duringDrive = [...mountLog];
      expect({
        mounts: mountsFor(duringDrive, CALL_ID),
        unmounts: unmountsFor(duringDrive, CALL_ID),
      }).toEqual({ mounts: 1, unmounts: 0 });
      expect(h.term.countOccurrences(`TOOLROW ${CALL_ID} pending`)).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("updates in place when the completing row is not last (parallel sibling below)", async () => {
    const h = createHarness(110, 12);
    try {
      const base = turns(4);
      h.render(base);
      await settle();
      // Image read starts, then a sibling tool starts below it.
      h.render([...base, pendingRead]);
      await settle();
      h.render([...base, pendingRead, pendingSibling]);
      await settle();
      // Image read completes in place while the sibling is still pending below.
      h.render([...base, completedImageRead, pendingSibling]);
      await settle();

      const duringDrive = [...mountLog];
      expect({
        mounts: mountsFor(duringDrive, CALL_ID),
        unmounts: unmountsFor(duringDrive, CALL_ID),
      }).toEqual({ mounts: 1, unmounts: 0 });
      // The sibling row never remounts either.
      expect(mountsFor(duringDrive, OTHER_ID)).toBe(1);
      expect(unmountsFor(duringDrive, OTHER_ID)).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
