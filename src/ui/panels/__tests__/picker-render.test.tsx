import { afterEach, describe, expect, test } from "bun:test";
import { Box, Text, useTerminalDimensions } from "@/ink";
import Ink from "@/terminal-runtime/host/runtime-session.tsx";
import { FooterPanel, FooterPanelPickerRow, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { visibleResumeRows } from "@/ui/panels/resume/entries.ts";
import { TerminalEmulator } from "@/ui/transcript/__tests__/terminal-emulator.ts";

function createStdout(term: TerminalEmulator): NodeJS.WriteStream {
  const listeners = new Map<string, Set<() => void>>();
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
    on(event: string, callback: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(callback);
      return stream;
    },
    off(event: string, callback: () => void) {
      listeners.get(event)?.delete(callback);
      return stream;
    },
    emitResize() {
      for (const callback of listeners.get("resize") ?? []) callback();
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

function ResponsivePickerFixture(): React.JSX.Element {
  const { rows } = useTerminalDimensions();
  const visibleRows = visibleResumeRows(rows);
  const visibleRowOrdinals = Array.from({ length: visibleRows }, (_, index) => index + 1);
  return (
    <Box flexDirection="column">
      <Text>{`Terminal rows ${rows} · visible rows ${visibleRows}`}</Text>
      {visibleRowOrdinals.map((ordinal) => (
        <FooterPanelPickerRow
          key={`row-${ordinal}`}
          label={`Responsive row ${ordinal}`}
          description={`Metadata ${ordinal}`}
        />
      ))}
    </Box>
  );
}

function FooterPanelRowFixture(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <FooterPanelRow label="Provider" value="Codex" width={60} />
      <FooterPanelRow label="Model" value="gpt-5" width={60} />
    </Box>
  );
}

function PickerFixture(): React.JSX.Element {
  return (
    <FooterPanel
      title="Resume session"
      search={{ query: "", placeholder: "Search…", focused: false }}
      footerHints={[
        ["Type", "search"],
        ["Space", "preview"],
        ["Ctrl+R", "rename"],
        ["Enter", "resume"],
        ["Esc", "cancel"],
      ]}
    >
      <Box flexDirection="column">
        <FooterPanelPickerRow
          label="Session alpha"
          description={<Text>1m ago · main · 2 KB</Text>}
          selected
          labelBold
        />
        <FooterPanelPickerRow
          label="Session beta"
          description={<Text>2m ago · HEAD · 4 KB</Text>}
          labelBold
        />
      </Box>
    </FooterPanel>
  );
}

describe("picker panel rendering", () => {
  let cleanup: (() => void) | null = null;

  test("keeps config values aligned without description hints", () => {
    const term = new TerminalEmulator(100, 8);
    const stdout = createStdout(term);
    const ink = new Ink({
      stdout,
      stdin: createStdin(),
      stderr: createStdout(new TerminalEmulator(100, 8)),
      exitOnCtrlC: true,
      patchConsole: false,
    });
    cleanup = () => {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    };

    ink.render(<FooterPanelRowFixture />);
    ink.onRender();

    const provider = term.visibleLines()[0] ?? "";
    expect(provider).toContain("Provider");
    expect(provider).toContain("Codex");
    expect(provider).not.toContain("selects the active AI service");
    expect(provider.indexOf("Codex")).toBe(62);

    const model = term.visibleLines()[1] ?? "";
    expect(model).toContain("Model");
    expect(model).toContain("gpt-5");
    expect(model).not.toContain("selects the active model");
    expect(model.indexOf("gpt-5")).toBe(62);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  test("keeps three-line rows and complete responsive hints across resize", () => {
    const term = new TerminalEmulator(110, 45);
    const stdout = createStdout(term);
    const ink = new Ink({
      stdout,
      stdin: createStdin(),
      stderr: createStdout(new TerminalEmulator(110, 45)),
      exitOnCtrlC: true,
      patchConsole: false,
    });
    cleanup = () => {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    };

    ink.render(<PickerFixture />);
    ink.onRender();

    const alphaRow = term.visibleRowOf("Session alpha");
    const betaRow = term.visibleRowOf("Session beta");
    expect(term.visibleRowOf("1m ago · main · 2 KB")).toBe(alphaRow + 1);
    expect(betaRow).toBe(alphaRow + 3);
    expect(term.visibleRowOf("2m ago · HEAD · 4 KB")).toBe(betaRow + 1);

    term.resize(80, 24);
    (stdout as unknown as { emitResize: () => void }).emitResize();
    ink.onRender();

    expect(term.countOccurrences("Resume session")).toBe(1);
    expect(term.countOccurrences("Session alpha")).toBe(1);
    expect(term.countOccurrences("1m ago · main · 2 KB")).toBe(1);
    expect(term.countOccurrences("Session beta")).toBe(1);
    expect(term.countOccurrences("2m ago · HEAD · 4 KB")).toBe(1);
    expect(term.visibleText()).toContain(
      "Type search · Space preview · Ctrl+R rename · Enter resume · Esc cancel",
    );
  });

  test("recomputes the visible row count from live terminal height", () => {
    const term = new TerminalEmulator(80, 24);
    const stdout = createStdout(term);
    const ink = new Ink({
      stdout,
      stdin: createStdin(),
      stderr: createStdout(new TerminalEmulator(80, 24)),
      exitOnCtrlC: true,
      patchConsole: false,
    });
    cleanup = () => {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    };

    ink.render(<ResponsivePickerFixture />);
    ink.onRender();
    expect(term.visibleText().match(/Responsive row/g)?.length).toBe(1);

    term.resize(110, 45);
    (stdout as unknown as { emitResize: () => void }).emitResize();
    ink.onRender();
    expect(term.visibleText()).toContain("Terminal rows 45 · visible rows 6");
    expect(term.visibleText().match(/Responsive row/g)?.length).toBe(6);
  });
});
