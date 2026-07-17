import { describe, expect, test } from "bun:test";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import type { KnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import { Ink } from "@/ink";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { DISCOVER_INPUT_GUIDE, footerHintsFor } from "@/ui/panels/plugins/chrome.ts";
import {
  DISCOVER_MAX_VISIBLE,
  discoverPageWindow,
  type PluginsPageRow,
  pluginsPageWindow,
  selectedInstalledPlugin,
} from "@/ui/panels/plugins/pagination.ts";
import { DiscoverView, InstalledView } from "@/ui/panels/plugins/views.tsx";
import { TerminalEmulator } from "@/ui/transcript/__tests__/terminal-emulator.ts";

type DiscoverRow = Extract<PluginsPageRow, { kind: "discover" }>;

function discoverRows(count: number): DiscoverRow[] {
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

function discoverRowsIn(window: { rows: readonly PluginsPageRow[] }): DiscoverRow[] {
  return window.rows.filter((row): row is DiscoverRow => row.kind === "discover");
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
    { kind: "add-marketplace", id: "add-marketplace", itemIndex: 0, height: 2 },
    ...marketplaces.map(
      (marketplace, index): PluginsPageRow => ({
        kind: "marketplace",
        id: `marketplace:${marketplace.name}`,
        itemIndex: index + 1,
        marketplace,
        pluginCount: index + 1,
        height: 4,
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
  test("continuous window shows the first five items", () => {
    const window = discoverPageWindow(discoverRows(10), 0, 0);
    expect(window.rows.map((row) => row.id)).toEqual([
      "market:Plugin 01",
      "market:Plugin 02",
      "market:Plugin 03",
      "market:Plugin 04",
      "market:Plugin 05",
    ]);
    expect(window.firstItem).toBe(0);
    expect(window.lastItem).toBe(4);
    expect(window.aboveItems).toBe(0);
    expect(window.belowItems).toBe(5);
    expect(window.itemCapacity).toBe(DISCOVER_MAX_VISIBLE);
  });

  test("continuous window advances one step when selection exits below", () => {
    const first = discoverPageWindow(discoverRows(10), 0, 0);
    const next = discoverPageWindow(discoverRows(10), 5, first.firstItem);
    expect(next.rows.map((row) => row.id)).toEqual([
      "market:Plugin 02",
      "market:Plugin 03",
      "market:Plugin 04",
      "market:Plugin 05",
      "market:Plugin 06",
    ]);
    expect(next.firstItem).toBe(1);
    expect(next.lastItem).toBe(5);
  });

  test("continuous window retains its offset when selection moves up within it", () => {
    const window = discoverPageWindow(discoverRows(10), 4, 1);
    expect(window.firstItem).toBe(1);
    expect(window.lastItem).toBe(5);
    expect(discoverRowsIn(window).map((row) => row.itemIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  test("continuous window snaps back to the start for the first selection", () => {
    const window = discoverPageWindow(discoverRows(10), 0, 1);
    expect(window.firstItem).toBe(0);
    expect(window.lastItem).toBe(4);
    expect(discoverRowsIn(window).map((row) => row.itemIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  test("continuous window shows the final five items", () => {
    const window = discoverPageWindow(discoverRows(12), 11, 0);
    expect(window.firstItem).toBe(7);
    expect(window.lastItem).toBe(11);
    expect(discoverRowsIn(window).map((row) => row.itemIndex)).toEqual([7, 8, 9, 10, 11]);
    expect(window.belowItems).toBe(0);
  });

  test("continuous window clamps its offset when filtering shrinks the list", () => {
    const full = discoverRows(12);
    const final = discoverPageWindow(full, 11, 7);
    const filtered = discoverPageWindow(full.slice(0, 3), 2, final.firstItem);
    expect(filtered.firstItem).toBe(0);
    expect(filtered.lastItem).toBe(2);
    expect(discoverRowsIn(filtered).map((row) => row.itemIndex)).toEqual([0, 1, 2]);
    expect(filtered.aboveItems).toBe(0);
    expect(filtered.belowItems).toBe(0);
  });

  test("tall terminal height still limits Discover to five rendered items", () => {
    const rows = discoverRows(8);
    const longDescription = `${"a".repeat(57)}🚀${"b".repeat(10)}`;
    rows[0]!.entry.description = longDescription;
    const window = discoverPageWindow(rows, 0, 0);
    const discover = rows.map((row) => ({ marketplace: row.marketplace, entry: row.entry }));
    const term = new TerminalEmulator(120, 40);
    const stdout = createStdout(term);
    const ink = new Ink({
      stdout,
      stdin: createStdin(),
      stderr: createStdout(new TerminalEmulator(120, 40)),
      exitOnCtrlC: true,
      patchConsole: false,
    });
    try {
      ink.render(
        <DiscoverView
          discover={discover}
          selected={0}
          marked={new Set()}
          window={window}
          filtered={false}
        />,
      );
      ink.onRender();

      expect(term.visibleText().match(/Plugin \d{2}/g)).toHaveLength(5);
      const itemRows = Array.from({ length: DISCOVER_MAX_VISIBLE }, (_, index) =>
        term.visibleRowOf(pluginName(index)),
      );
      expect(itemRows.every((row) => row >= 0)).toBe(true);
      expect(itemRows.slice(1).map((row, index) => row - itemRows[index]!)).toEqual([3, 3, 3, 3]);
      const lines = term.visibleLines();
      const blankRows = itemRows
        .slice(0, -1)
        .reduce(
          (count, row, index) =>
            count + lines.slice(row + 2, itemRows[index + 1]!).filter((line) => line === "").length,
          0,
        );
      expect(blankRows).toBe(4);
      expect(term.visibleText()).toContain("↓ more below");
      expect(term.visibleText()).not.toContain("↑ more above");
      expect(term.visibleText()).not.toContain("↓ 3 more below");
      expect(term.visibleRowOf("↓ more below")).toBe(itemRows.at(-1)! + 2);
      const truncatedDescription = `${"a".repeat(57)}🚀…`;
      expect(stringWidth(truncatedDescription)).toBe(60);
      expect(term.visibleText()).toContain(truncatedDescription);
      expect(term.visibleText()).not.toContain(`${"a".repeat(57)}🚀b`);
    } finally {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    }
  });

  test("Discover footer exposes the input guide without page or tab hints", () => {
    expect(footerHintsFor("discover", "list")).toEqual([]);
    expect(DISCOVER_INPUT_GUIDE).toBe(
      "Type to search · Space to toggle · Enter to view · Esc to go back",
    );
    expect(DISCOVER_INPUT_GUIDE).not.toContain("PgUp");
    expect(DISCOVER_INPUT_GUIDE).not.toContain("←/→");
  });

  test("keeps the add row with the first marketplace entry", () => {
    const rows = marketplaceRows(12);
    const first = pluginsPageWindow(rows, 0, 6);
    expect(first.rows.map((row) => row.kind)).toEqual(["add-marketplace", "marketplace"]);
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
        <InstalledView
          installed={installed}
          selected={10}
          favorites={new Set()}
          runtimeEnabled={new Set(installed.map((plugin) => plugin.name))}
          window={window}
        />,
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
