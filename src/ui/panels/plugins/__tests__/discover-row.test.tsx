import { describe, expect, test } from "bun:test";
import { Box, Ink } from "@/ink";
import { DiscoverView } from "@/ui/panels/plugins/views.tsx";
import { TerminalEmulator } from "@/ui/transcript/__tests__/terminal-emulator.ts";

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
  const stream = {
    isTTY: false,
    isRaw: false,
    setRawMode() {},
    listeners: () => [],
    addListener() {
      return stream;
    },
    removeListener() {
      return stream;
    },
    on() {
      return stream;
    },
    off() {
      return stream;
    },
  };
  return stream as unknown as NodeJS.ReadStream;
}

type FakeItem = {
  entry: {
    name: string;
    description: string;
    tags?: string[];
    installCount?: number;
  };
  marketplace: string;
};

const ITEMS: FakeItem[] = [
  {
    entry: {
      name: "context7",
      description: "Up-to-date docs",
      tags: ["community-managed"],
      installCount: 355_400,
    },
    marketplace: "claude-plugins-official",
  },
  {
    entry: { name: "skill-creator", description: "Create skills", installCount: 347_500 },
    marketplace: "claude-plugins-official",
  },
];

describe("DiscoverView rows at 60 columns", () => {
  test("long muted tails never blank or truncate the plugin name", () => {
    const rows = ITEMS.map((item, index) => ({
      kind: "discover" as const,
      id: `d${index}`,
      itemIndex: index,
      height: 2,
      entry: item.entry,
      marketplace: item.marketplace,
    }));
    const term = new TerminalEmulator(60, 14);
    const ink = new Ink({
      stdout: createStdout(term),
      stdin: createStdin(),
      stderr: createStdout(new TerminalEmulator(60, 14)),
      exitOnCtrlC: true,
      patchConsole: false,
    });
    try {
      ink.render(
        <Box flexDirection="column" paddingX={2} width="100%">
          <DiscoverView
            discover={ITEMS as never}
            selected={0}
            marked={new Set<string>()}
            window={{ rows, aboveItems: 0, belowItems: 0 } as never}
            filtered={false}
          />
        </Box>,
      );
      ink.onRender();
      const frame = term.visibleText();
      expect(frame).toContain("context7");
      expect(frame).toContain("skill-creator");
      // The muted tail truncates with an ellipsis instead of wrapping.
      expect(frame).toContain("…");
    } finally {
      ink.unmount();
    }
  });
});
