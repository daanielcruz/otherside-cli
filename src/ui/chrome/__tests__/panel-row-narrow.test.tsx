import { describe, expect, test } from "bun:test";
import { Box, Ink } from "@/ink";
import { FooterPanelRow } from "@/ui/chrome/panel.tsx";
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

function renderRows(columns: number, rows: React.JSX.Element): string[] {
  const term = new TerminalEmulator(columns, 12);
  const ink = new Ink({
    stdout: createStdout(term),
    stdin: createStdin(),
    stderr: createStdout(new TerminalEmulator(columns, 12)),
    exitOnCtrlC: true,
    patchConsole: false,
  });
  try {
    ink.render(
      <Box flexDirection="column" paddingX={2} width="100%">
        {rows}
      </Box>,
    );
    ink.onRender();
    return term.visibleText().split("\n");
  } finally {
    ink.unmount();
  }
}

describe("FooterPanelRow at narrow widths", () => {
  test("every value stays on its own row and ellipsizes", () => {
    const lines = renderRows(
      40,
      <>
        <FooterPanelRow label="Provider" value="Anthropic" />
        <FooterPanelRow label="Image generator" value="Codex" />
        <FooterPanelRow label="Language" value="Japanese" />
      </>,
    );
    expect(lines[0]).toContain("Provider");
    expect(lines[1]).toContain("Image generator");
    expect(lines[2]).toContain("Language");
    // No value fragment wraps onto a continuation line.
    expect(lines[3]?.trim() ?? "").toBe("");
    // Rows align on one indentation column: the marker never shrinks.
    for (const line of lines.slice(0, 3)) {
      expect(line.startsWith("    ")).toBe(true);
    }
  });

  test("truncating descriptions do not create phantom blank lines", () => {
    const lines = renderRows(
      80,
      <>
        <FooterPanelRow
          label="Orchestration"
          value="default"
          description="feudalism enforces tier chain-of-command and quota fallback routing behavior"
        />
        <FooterPanelRow label="Chain of command" value="enabled" />
      </>,
    );
    expect(lines[0]).toContain("Orchestration");
    expect(lines[0]).toContain("…");
    expect(lines[1]).toContain("Chain of command");
  });
});
