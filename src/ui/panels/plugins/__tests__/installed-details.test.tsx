import { describe, expect, test } from "bun:test";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import { Ink } from "@/ink";
import {
  footerHintsFor,
  INSTALLED_DETAILS_HINTS,
  tabLabelFor,
} from "@/ui/panels/plugins/chrome.ts";
import { InstalledDetailsView } from "@/ui/panels/plugins/views.tsx";
import { TerminalEmulator } from "@/ui/transcript/__tests__/terminal-emulator.ts";

function fakePlugin(): LoadedPlugin {
  return {
    name: "demo-plugin",
    source: "demo-plugin@market",
    path: "/fixtures/demo-plugin",
    manifest: {
      name: "demo-plugin",
      version: "1.2.3",
      description: "A demo plugin",
      author: { name: "Someone" },
      homepage: "https://example.com",
    },
  } as unknown as LoadedPlugin;
}

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

describe("plugins tab labels", () => {
  test("errors tab carries the live error count", () => {
    expect(tabLabelFor("errors", 0)).toBe("Errors");
    expect(tabLabelFor("errors", 3)).toBe("Errors (3)");
    expect(tabLabelFor("installed", 3)).toBe("Installed");
  });
});

describe("installed footer hints", () => {
  test("list hints separate toggle and view; details hints navigate", () => {
    const hints = footerHintsFor("installed", "list");
    expect(hints).toContainEqual(["Space", "toggle"]);
    expect(hints).toContainEqual(["Enter", "view"]);
    expect(INSTALLED_DETAILS_HINTS).toContainEqual(["Enter", "to select"]);
  });
});

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

describe("InstalledDetailsView", () => {
  test("renders identity, metadata, and the action menu with selection", () => {
    const term = new TerminalEmulator(80, 24);
    const ink = new Ink({
      stdout: createStdout(term),
      stdin: createStdin(),
      stderr: createStdout(new TerminalEmulator(80, 24)),
      exitOnCtrlC: true,
      patchConsole: false,
    });
    try {
      ink.render(
        <InstalledDetailsView
          plugin={fakePlugin()}
          actions={[
            { id: "toggle", label: "Disable plugin" },
            { id: "favorite", label: "Add to favorites" },
            { id: "back", label: "Back to plugin list" },
          ]}
          actionIndex={1}
        />,
      );
      ink.onRender();
      const frame = term.visibleText();
      expect(frame).toContain("demo-plugin @ demo-plugin@market");
      expect(frame).toContain("Version: 1.2.3");
      expect(frame).toContain("A demo plugin");
      expect(frame).toContain("Author: Someone");
      expect(frame).toContain("Disable plugin");
      expect(frame).toContain("Add to favorites");
      expect(frame).toContain("Back to plugin list");
    } finally {
      ink.unmount();
    }
  });
});
