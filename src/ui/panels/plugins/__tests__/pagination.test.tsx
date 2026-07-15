import { describe, expect, test } from "bun:test";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import type { KnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import Ink from "@/terminal-runtime/host/runtime-session.tsx";
import {
  clampPluginsIndex,
  type PluginsPageRow,
  pagePluginsIndex,
  pluginsPageRows,
  pluginsPageWindow,
  selectedInstalledPlugin,
} from "@/ui/panels/plugins/pagination.ts";
import { InstalledView } from "@/ui/panels/plugins/views.tsx";
import { TerminalEmulator } from "@/ui/transcript/__tests__/terminal-emulator.ts";

function discoverRows(count: number): PluginsPageRow[] {
  return Array.from({ length: count }, (_, itemIndex) => ({
    kind: "discover" as const,
    id: `market:${pluginName(itemIndex)}`,
    itemIndex,
    marketplace: "market",
    entry: {
      name: pluginName(itemIndex),
      description: `Description ${itemIndex + 1}`,
      source: `./plugin-${itemIndex + 1}`,
    },
    height: 2 as const,
  }));
}

function pluginName(index: number): string {
  return `Plugin ${String(index + 1).padStart(2, "0")}`;
}

function marketplaceRows(count: number): PluginsPageRow[] {
  const date = "2026-01-01T00:00:00.000Z";
  const marketplaces: KnownMarketplace[] = Array.from({ length: count }, (_, index) => ({
    name: `Market ${index + 1}`,
    source: `owner/market-${index + 1}`,
    sourceType: "github",
    installLocation: `/fixtures/market-${index + 1}`,
    lastUpdated: date,
  }));
  return [
    {
      kind: "marketplace-heading",
      id: "marketplace-heading",
      label: "Manage marketplaces",
      height: 1,
    },
    { kind: "add-marketplace", id: "add-marketplace", itemIndex: 0, height: 2 },
    ...marketplaces.map(
      (marketplace, index): PluginsPageRow => ({
        kind: "marketplace",
        id: `marketplace:${marketplace.name}`,
        itemIndex: index + 1,
        marketplace,
        pluginCount: index + 1,
        height: 3,
      }),
    ),
  ];
}

function installedPlugin(index: number): LoadedPlugin {
  return {
    name: pluginName(index),
    path: `/fixtures/plugin-${index + 1}`,
    source: "fixtures",
    manifest: { name: pluginName(index) },
  };
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

describe("plugins pagination", () => {
  test("pages many discover rows across first, middle, and last pages", () => {
    const rows = discoverRows(30);
    const visible = pluginsPageRows(24, {
      searchVisible: true,
      commandResult: false,
      busy: false,
    });
    expect(visible).toBe(8);

    const first = pluginsPageWindow(rows, 0, visible);
    expect(first.rows.map((row) => row.id)).toEqual([
      "market:Plugin 01",
      "market:Plugin 02",
      "market:Plugin 03",
      "market:Plugin 04",
    ]);
    expect(first.aboveItems).toBe(0);
    expect(first.belowItems).toBe(26);

    const middle = pluginsPageWindow(rows, 15, visible);
    expect(middle.firstItem).toBe(12);
    expect(middle.lastItem).toBe(15);
    expect(middle.aboveItems).toBe(12);
    expect(middle.belowItems).toBe(14);

    const last = pluginsPageWindow(rows, 29, visible);
    expect(last.firstItem).toBe(28);
    expect(last.lastItem).toBe(29);
    expect(last.belowItems).toBe(0);
  });

  test("recomputes capacity and clamps page movement after resize", () => {
    const rows = discoverRows(30);
    const tall = pluginsPageRows(40, {
      searchVisible: true,
      commandResult: false,
      busy: false,
    });
    const short = pluginsPageRows(20, {
      searchVisible: true,
      commandResult: false,
      busy: false,
    });
    expect(tall).toBeGreaterThan(short);

    const selected = clampPluginsIndex(29, rows.length);
    const resized = pluginsPageWindow(rows, selected, short);
    expect(resized.lastItem).toBe(29);
    expect(resized.belowItems).toBe(0);
    expect(pagePluginsIndex(selected, rows.length, 1, resized.itemCapacity)).toBe(29);
    expect(clampPluginsIndex(selected, 4)).toBe(3);
  });

  test("keeps marketplace heading with add row and pages all grouped entries", () => {
    const rows = marketplaceRows(12);
    const first = pluginsPageWindow(rows, 0, 6);
    expect(first.rows.map((row) => row.kind)).toEqual([
      "marketplace-heading",
      "add-marketplace",
      "marketplace",
    ]);
    const middle = pluginsPageWindow(rows, 6, 6);
    expect(middle.rows.every((row) => row.kind === "marketplace")).toBe(true);
    const last = pluginsPageWindow(rows, 12, 6);
    expect(last.belowItems).toBe(0);
    expect(last.rows.at(-1)?.id).toBe("marketplace:Market 12");
  });

  test("filtered rows paginate by filtered identity", () => {
    const filtered = discoverRows(30)
      .filter((row): row is Extract<PluginsPageRow, { kind: "discover" }> =>
        row.kind === "discover" ? row.entry.name.endsWith("2") : false,
      )
      .map((row, itemIndex): PluginsPageRow => ({ ...row, itemIndex }));
    const window = pluginsPageWindow(filtered, 1, 4);
    expect(window.rows.map((row) => row.id)).toEqual(["market:Plugin 02", "market:Plugin 12"]);
    expect(window.firstItem).toBe(0);
    expect(window.lastItem).toBe(1);
  });

  test("renders and selects the requested action target on a non-first page", () => {
    const installed = Array.from({ length: 15 }, (_, index) => installedPlugin(index));
    const rows: PluginsPageRow[] = [
      { kind: "heading", id: "installed-heading", label: "User", height: 1 },
      ...installed.map(
        (plugin, itemIndex): PluginsPageRow => ({
          kind: "installed",
          id: `installed:${plugin.name}`,
          itemIndex,
          plugin,
          height: 1,
        }),
      ),
    ];
    const window = pluginsPageWindow(rows, 10, 5);
    expect(window.firstItem).toBe(9);
    expect(window.lastItem).toBe(13);
    expect(selectedInstalledPlugin(installed, 10)?.name).toBe("Plugin 11");

    const term = new TerminalEmulator(80, 12);
    const stdout = createStdout(term);
    const ink = new Ink({
      stdout,
      stdin: createStdin(),
      stderr: createStdout(new TerminalEmulator(80, 12)),
      exitOnCtrlC: true,
      patchConsole: false,
    });
    try {
      ink.render(
        <InstalledView installed={installed} selected={10} favorites={new Set()} window={window} />,
      );
      ink.onRender();
      const selectedLine = term.visibleLines().find((line) => line.includes("Plugin 11"));
      expect(selectedLine).toContain("❯");
      expect(term.visibleText()).not.toContain("Plugin 01");
      expect(term.visibleText()).toContain("↑ 9 more above");
    } finally {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    }
  });
});
