import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import {
  _markOfficialCheckoutUnavailableForTesting,
  _resetOfficialCatalogForTesting,
  addMarketplace,
  OFFICIAL_MARKETPLACE_NAME,
} from "@/engine/plugins/marketplace.ts";
import { removeKnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import {
  snapshot as pluginSnapshot,
  register as registerPlugin,
  replaceSnapshot as replacePluginSnapshot,
} from "@/engine/plugins/registry.ts";
import {
  register as registerSkill,
  replaceSnapshot as replaceSkillSnapshot,
  snapshot as skillSnapshot,
} from "@/engine/skills/registry.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { renderAddMarketplace } from "@/ui/panels/plugins/panel-render.ts";
import {
  initialPanelState,
  withData,
  withMarketplaces,
  withNav,
} from "@/ui/panels/plugins/panel-state.ts";
import { createPluginsPanel } from "@/ui/panels/plugins/string-view.ts";
import { Color } from "@/ui/theme/theme.ts";

const WIDTH = 80;
const MARKETPLACE_NAME = "test-window-marketplace";
const DISCOVER_PLUGIN_COUNT = 9;
const SKILL_COUNT = 10;
const LIST_GUIDE_TEXT = "Type to search · Space to toggle · Enter to view · Esc to go back";

const TERMINAL_ROWS = 40;

const originalColorLevel = chalk.level;
const originalSkills = skillSnapshot();
let marketplaceDir = "";

// The panel reads geometry from its mount context and its config loads go
// through the io seam, so the rig never touches process.stdout or real config.
function testPanel(
  close: () => void = () => {},
  terminalRows = TERMINAL_ROWS,
): ReturnType<typeof createPluginsPanel> {
  const panel = createPluginsPanel(close, undefined, {
    refreshCatalog: async () => null,
    loadMcpConfig: async () => ({ config: { mcpServers: {} }, sources: {} }),
    loadDisabledMcp: async () => new Set<string>(),
  });
  panel.mount?.({
    requestRender: () => {},
    pushFocus: () => {},
    popFocus: () => {},
    terminalRows: () => terminalRows,
  });
  return panel;
}

function pluginName(index: number): string {
  return `plugin-${String(index + 1).padStart(2, "0")}`;
}

function skillName(index: number): string {
  return `test-skill-${String(index).padStart(2, "0")}`;
}

beforeAll(async () => {
  chalk.level = 3;
  // Never attempt the official-marketplace network bootstrap from a test.
  _markOfficialCheckoutUnavailableForTesting();

  marketplaceDir = mkdtempSync(join(tmpdir(), "plugins-panel-test-"));
  mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(marketplaceDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: MARKETPLACE_NAME,
      plugins: Array.from({ length: DISCOVER_PLUGIN_COUNT }, (_, index) => ({
        name: pluginName(index),
        source: `./plugins/${pluginName(index)}`,
        description: `Test plugin ${index + 1}`,
      })),
    }),
  );
  const added = await addMarketplace(marketplaceDir);
  if (!added.ok) throw new Error(`test marketplace not added: ${added.error}`);

  for (let index = 0; index < SKILL_COUNT; index++) {
    registerSkill({
      name: skillName(index),
      aliases: [],
      description: `Test skill ${index}`,
      whenToUse: "In tests.",
      argumentHint: null,
      userInvocable: true,
      modelInvocable: true,
      context: "inline",
      body: "Test body.",
      builtin: false,
      source: "user",
      authorModelLock: false,
    });
  }
});

afterAll(() => {
  chalk.level = originalColorLevel;
  replaceSkillSnapshot(originalSkills);
  removeKnownMarketplace(MARKETPLACE_NAME);
  rmSync(marketplaceDir, { recursive: true, force: true });
  _resetOfficialCatalogForTesting();
});

function key(name: string, overrides: Partial<KeyEventData> = {}): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: name.length === 1 ? name : undefined,
    raw: undefined,
    isPasted: false,
    ...overrides,
  };
}

function typeText(panel: ReturnType<typeof createPluginsPanel>, text: string): void {
  for (const ch of text) panel.handleKey(key(ch));
}

function renderPlain(panel: ReturnType<typeof createPluginsPanel>): string[] {
  return panel.render(WIDTH).map(stripAnsi);
}

function activeChip(label: string): string {
  return renderTextWithStyles(` ${label} `, {
    bold: true,
    backgroundColor: Color.panelAccent,
    color: Color.tabSelectedText,
  });
}

function reverseChip(label: string): string {
  return renderTextWithStyles(` ${label} `, { bold: true, inverse: true });
}

/** The focused empty box renders its placeholder with an inverse cursor on the first char. */
function searchHasFocusCursor(lines: string[]): boolean {
  return lines.some((line) => line.includes(renderTextWithStyles("S", { inverse: true })));
}

function headerRowOf(lines: string[]): string {
  const row = lines.find((line) => stripAnsi(line).includes("Discover"));
  if (row === undefined) throw new Error("tab header row not rendered");
  return row;
}

describe("plugins panel windows", () => {
  it("windows the discover list to five items with dim markers and the (N/M) counter", () => {
    const panel = testPanel();
    const lines = panel.render(WIDTH);
    const plain = lines.map(stripAnsi);

    expect(plain.some((line) => line.includes("Discover plugins (1/9)"))).toBe(true);
    for (let index = 0; index < 5; index++) {
      expect(plain.some((line) => line.includes(pluginName(index)))).toBe(true);
    }
    expect(plain.some((line) => line.includes(pluginName(5)))).toBe(false);
    expect(plain.some((line) => line.includes("more above"))).toBe(false);
    const marker = lines.find((line) => stripAnsi(line).includes("more below"));
    expect(marker).toBeDefined();
    expect(marker).toContain(renderTextWithStyles(" ↓ more below", { dim: true }));
  });

  it("separates discover entries with a blank row and insets descriptions under the name", () => {
    const panel = testPanel();
    const plain = renderPlain(panel);
    const first = plain.findIndex((line) => line.includes(pluginName(0)));
    expect(plain[first + 1]).toContain(`    Test plugin 1`);
    expect(plain[first + 2]?.trim()).toBe("");
    expect(plain[first + 3]).toContain(pluginName(1));
    // The last visible entry sits flush against the window marker.
    const last = plain.findIndex((line) => line.includes(pluginName(4)));
    expect(plain[last + 2]?.trim()).toBe("↓ more below");
  });

  it("fits the discover window and its guide inside the shared frame budget", () => {
    const panel = testPanel(() => {}, 32);
    const lines = panel.render(WIDTH);
    const plain = lines.map(stripAnsi);

    expect(lines.length + 7).toBeLessThanOrEqual(32);
    expect(plain.some((line) => line.includes(pluginName(3)))).toBe(true);
    expect(plain.some((line) => line.includes(pluginName(4)))).toBe(false);
    const last = plain.findIndex((line) => line.includes(pluginName(3)));
    expect(plain[last + 1]).toContain("Test plugin 4");
    expect(plain[last + 2]?.trim()).toBe("↓ more below");
    expect(plain.some((line) => /↓ \d+ more$/.test(line.trim()))).toBe(false);
  });

  it("opens a gap between the tabs row and the installed search box", () => {
    const panel = testPanel();
    panel.handleKey(key("tab"));
    const plain = renderPlain(panel);
    const header = plain.findIndex((line) => line.includes("Discover"));
    expect(plain[header + 1]?.trim()).toBe("");
    expect(plain[header + 2]).toContain("╭");
  });

  it("slides the discover window with the cursor and shows both markers mid-list", () => {
    const panel = testPanel();
    for (let presses = 0; presses < 7; presses++) panel.handleKey(key("down"));
    const plain = renderPlain(panel);

    expect(plain.some((line) => line.includes("Discover plugins (8/9)"))).toBe(true);
    expect(plain.some((line) => line.includes(pluginName(2)))).toBe(false);
    for (let index = 3; index < 8; index++) {
      expect(plain.some((line) => line.includes(pluginName(index)))).toBe(true);
    }
    expect(plain.some((line) => line.includes(pluginName(8)))).toBe(false);
    expect(plain.some((line) => line.trim() === "↑ more above")).toBe(true);
    expect(plain.some((line) => line.trim() === "↓ more below")).toBe(true);
  });

  it("windows the installed list to eight rows with the shared markers", () => {
    const panel = testPanel();
    panel.handleKey(key("tab"));
    typeText(panel, "test-skill");
    panel.handleKey(key("down"));

    let plain = renderPlain(panel);
    for (let index = 0; index < 8; index++) {
      expect(plain.some((line) => line.includes(skillName(index)))).toBe(true);
    }
    expect(plain.some((line) => line.includes(skillName(8)))).toBe(false);
    expect(plain.some((line) => line.trim() === "↓ more below")).toBe(true);
    expect(plain.some((line) => line.includes("more above"))).toBe(false);

    for (let presses = 0; presses < 9; presses++) panel.handleKey(key("down"));
    plain = renderPlain(panel);
    expect(plain.some((line) => line.includes(skillName(1)))).toBe(false);
    for (let index = 2; index < 10; index++) {
      expect(plain.some((line) => line.includes(skillName(index)))).toBe(true);
    }
    expect(plain.some((line) => line.trim() === "↑ more above")).toBe(true);
    expect(plain.some((line) => line.includes("more below"))).toBe(false);
  });
});

describe("plugins panel tabs", () => {
  it("cycles tabs with tab and arrow keys and styles the active chip by focus", () => {
    const panel = testPanel();
    expect(headerRowOf(panel.render(WIDTH))).toContain(activeChip("Discover"));

    panel.handleKey(key("tab"));
    expect(headerRowOf(panel.render(WIDTH))).toContain(activeChip("Installed"));

    panel.handleKey(key("right"));
    const marketplaceLines = panel.render(WIDTH);
    const marketplaces = marketplaceLines.map(stripAnsi);
    expect(headerRowOf(marketplaceLines)).toContain(activeChip("Marketplaces"));
    expect(marketplaces.some((line) => line.includes("Manage marketplaces"))).toBe(true);
    expect(marketplaces.some((line) => line.includes("+ Add Marketplace"))).toBe(true);
    expect(marketplaces.some((line) => line.includes(MARKETPLACE_NAME))).toBe(true);
    const official = marketplaceLines.find((line) =>
      stripAnsi(line).includes(`✻ ${OFFICIAL_MARKETPLACE_NAME} ✻`),
    );
    expect(official).toBeDefined();
    expect(official).toContain(renderTextWithStyles("✻ ", { bold: true, color: "ansi256(174)" }));

    panel.handleKey(key("tab", { shift: true }));
    expect(headerRowOf(panel.render(WIDTH))).toContain(activeChip("Installed"));
    panel.handleKey(key("left"));
    expect(headerRowOf(panel.render(WIDTH))).toContain(activeChip("Discover"));
  });

  it("keeps a body gap on the errors list", () => {
    const panel = testPanel();
    panel.handleKey(key("left"));
    const plain = renderPlain(panel);
    const header = plain.findIndex((line) => line.includes("Discover") && line.includes("Errors"));

    expect(plain[header + 1]).toBe("");
    expect(plain[header + 2]).toContain("No plugin errors");
  });

  it("renders the active chip reverse-video while search holds focus", () => {
    const panel = testPanel();
    typeText(panel, "p");
    const header = headerRowOf(panel.render(WIDTH));
    expect(header).toContain(reverseChip("Discover"));
    expect(header).not.toContain(activeChip("Discover"));
  });
});

describe("plugins panel search", () => {
  it("seeds the query from typed characters and filters the list", () => {
    const panel = testPanel();
    typeText(panel, pluginName(8));
    const plain = renderPlain(panel);
    expect(plain.some((line) => line.includes("Discover plugins (1/1)"))).toBe(true);
    expect(plain.some((line) => line.includes(pluginName(8)))).toBe(true);
    expect(plain.some((line) => line.includes(pluginName(0)))).toBe(false);
  });

  it("clears the query on the first Esc, exits search on the second, closes on the third", () => {
    let closed = false;
    const panel = testPanel(() => {
      closed = true;
    });
    typeText(panel, pluginName(8));

    panel.handleKey(key("escape", { sequence: "\x1b" }));
    const cleared = panel.render(WIDTH);
    expect(cleared.map(stripAnsi).some((line) => line.includes("Discover plugins (1/9)"))).toBe(
      true,
    );
    // Cleared but still focused: the chip returns to the header while the
    // cursor stays in the box.
    expect(headerRowOf(cleared)).toContain(activeChip("Discover"));
    expect(searchHasFocusCursor(cleared)).toBe(true);

    panel.handleKey(key("escape", { sequence: "\x1b" }));
    expect(searchHasFocusCursor(panel.render(WIDTH))).toBe(false);
    expect(closed).toBe(false);

    panel.handleKey(key("escape", { sequence: "\x1b" }));
    expect(closed).toBe(true);
  });

  it("enters search with slash or up-from-top and exits on backspace or down", () => {
    const panel = testPanel();
    panel.handleKey(key("/"));
    expect(searchHasFocusCursor(panel.render(WIDTH))).toBe(true);

    panel.handleKey(key("backspace"));
    expect(searchHasFocusCursor(panel.render(WIDTH))).toBe(false);

    panel.handleKey(key("up"));
    expect(searchHasFocusCursor(panel.render(WIDTH))).toBe(true);

    panel.handleKey(key("down"));
    expect(searchHasFocusCursor(panel.render(WIDTH))).toBe(false);
  });

  it("keeps the chip and tab keys on the header while the focused box is empty", () => {
    const panel = testPanel();
    panel.handleKey(key("up"));
    const focusedEmpty = panel.render(WIDTH);
    expect(searchHasFocusCursor(focusedEmpty)).toBe(true);
    expect(headerRowOf(focusedEmpty)).toContain(activeChip("Discover"));

    // Right still switches tabs; the switch drops the box's focus.
    panel.handleKey(key("right"));
    const switched = panel.render(WIDTH);
    expect(headerRowOf(switched)).toContain(activeChip("Installed"));
    expect(searchHasFocusCursor(switched)).toBe(false);
  });

  it("locks tab keys to the box once it holds text", () => {
    const panel = testPanel();
    typeText(panel, "p");
    expect(headerRowOf(panel.render(WIDTH))).toContain(reverseChip("Discover"));

    panel.handleKey(key("right"));
    expect(headerRowOf(panel.render(WIDTH))).toContain(reverseChip("Discover"));
    panel.handleKey(key("tab"));
    expect(headerRowOf(panel.render(WIDTH))).toContain(reverseChip("Discover"));
  });

  it("steps back from discover details before closing the panel", () => {
    let closed = false;
    const panel = testPanel(() => {
      closed = true;
    });
    panel.handleKey(key("return"));
    const details = renderPlain(panel);
    expect(details.some((line) => line.includes("Install for you (user scope)"))).toBe(true);

    panel.handleKey(key("escape", { sequence: "\x1b" }));
    const list = renderPlain(panel);
    expect(list.some((line) => line.includes("Discover plugins (1/9)"))).toBe(true);
    expect(closed).toBe(false);
  });
});

describe("plugins panel hints", () => {
  it("phrases the discover and installed guides through the hint vocabulary", () => {
    const panel = testPanel();
    expect(renderPlain(panel).some((line) => line.trim() === LIST_GUIDE_TEXT)).toBe(true);

    // The installed list adds the favorite shortcut between toggle and view;
    // wider than the default test width, so this assert renders at 100 columns.
    panel.handleKey(key("tab"));
    const installedGuide =
      "Type to search · Space to toggle · f to favorite · Enter to view · Esc to go back";
    const wide = panel.render(100).map(stripAnsi);
    expect(wide.some((line) => line.trim() === installedGuide)).toBe(true);
  });

  it("prepends a bold install hint while a discover selection is marked", () => {
    const panel = testPanel();
    expect(renderPlain(panel).some((line) => line.includes("i to install"))).toBe(false);

    panel.handleKey(key("space", { sequence: " " }));
    const lines = panel.render(WIDTH);
    const guide = lines.find((line) => stripAnsi(line).includes("i to install"));
    expect(guide).toBeDefined();
    expect(guide).toContain(
      renderTextWithStyles("i to install", { color: Color.muted, italic: true, bold: true }),
    );
  });
});

function freshPanelState() {
  return initialPanelState({ commandResult: null, favorites: new Set() });
}

describe("marketplace add and remove flows", () => {
  function toMarketplacesTab(panel: ReturnType<typeof createPluginsPanel>): void {
    panel.handleKey(key("tab"));
    panel.handleKey(key("tab"));
  }

  it("paints the busy spinner line under the add form", () => {
    const busyState = withData(
      withNav(withMarketplaces(freshPanelState(), { addInput: "owner/repo" }), {
        tab: "marketplaces",
      }),
      { busy: "Adding marketplace to configuration…" },
    );
    const plain = renderAddMarketplace(busyState, WIDTH).map(stripAnsi);
    const busyLine = plain.find((line) => line.includes("Adding marketplace to configuration…"));
    expect(busyLine).toBeDefined();
    expect(busyLine?.trim().length).toBeGreaterThan("Adding marketplace to configuration…".length);
  });

  it("keeps a blank margin row between the tab header and the remove confirmation", () => {
    const panel = testPanel();
    toMarketplacesTab(panel);
    panel.handleKey(key("down"));
    panel.handleKey(key("r"));

    const plain = renderPlain(panel);
    const headerIndex = plain.findIndex((line) => line.includes("Marketplaces"));
    // Roster order varies with the environment; any selected marketplace serves
    // the margin assertion.
    const titleIndex = plain.findIndex((line) => line.includes("Remove marketplace "));
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(titleIndex).toBeGreaterThan(headerIndex);
    expect(plain[headerIndex + 1]?.trim()).toBe("");
    expect(titleIndex).toBe(headerIndex + 2);
  });

  it("a repeated Enter on a failing add settles back to the list without a stuck busy", async () => {
    const panel = testPanel();
    toMarketplacesTab(panel);
    panel.handleKey(key("a"));
    typeText(panel, join(tmpdir(), "missing-marketplace-abc"));
    panel.handleKey(key("return"));
    panel.handleKey(key("return"));

    for (let attempt = 0; attempt < 200; attempt++) {
      const plain = renderPlain(panel);
      if (!plain.some((line) => line.includes("Add marketplace"))) break;
      await Bun.sleep(1);
    }
    const plain = renderPlain(panel);
    expect(plain.some((line) => line.includes("Add marketplace"))).toBe(false);
    expect(plain.some((line) => line.includes("Adding marketplace"))).toBe(false);
  });
});

describe("marketplace browse", () => {
  /** Drill into the test marketplace's detail screen, whatever its roster position. */
  function openTestMarketplaceDetail(panel: ReturnType<typeof createPluginsPanel>): void {
    panel.handleKey(key("tab"));
    panel.handleKey(key("tab"));
    for (let steps = 0; steps < 12; steps++) {
      panel.handleKey(key("down"));
      panel.handleKey(key("return"));
      if (renderPlain(panel).some((line) => line.trim().startsWith(MARKETPLACE_NAME))) return;
      panel.handleKey(key("left"));
    }
    throw new Error("test marketplace detail not reached");
  }

  function withInstalledFirstPlugin(run: () => void): void {
    const before = pluginSnapshot();
    registerPlugin({
      name: pluginName(0),
      path: join(marketplaceDir, "plugins", pluginName(0)),
      source: MARKETPLACE_NAME,
      manifest: { name: pluginName(0), description: "Test plugin 1" },
    });
    try {
      run();
    } finally {
      replacePluginSnapshot(before);
    }
  }

  it("browses the whole marketplace catalogue, ticking what is already installed", () => {
    withInstalledFirstPlugin(() => {
      const panel = testPanel();
      openTestMarketplaceDetail(panel);
      panel.handleKey(key("return"));

      const lines = panel.render(WIDTH);
      const plain = lines.map(stripAnsi);
      expect(plain.some((line) => line.includes("Install Plugins (1/9)"))).toBe(true);
      expect(plain.some((line) => line.includes("No plugins match your search."))).toBe(false);

      panel.handleKey(key("down"));
      const afterMove = panel.render(WIDTH);
      const installedRow = afterMove.find((line) =>
        stripAnsi(line).includes(`${pluginName(0)} (installed)`),
      );
      expect(installedRow).toBeDefined();
      expect(installedRow).toContain(
        renderTextWithStyles(`✔ ${pluginName(0)}`, {
          color: Color.success,
          bold: false,
          italic: false,
        }),
      );
      expect(installedRow).toContain(renderTextWithStyles(" (installed)", { color: Color.muted }));
      // The marketplace names itself in the subtitle; the rows do not repeat it.
      const plainRow = afterMove.map(stripAnsi).find((line) => line.includes(pluginName(1)));
      expect(plainRow).not.toContain(`· ${MARKETPLACE_NAME}`);
    });
  });

  it("keeps installed plugins out of the unscoped discover feed", () => {
    withInstalledFirstPlugin(() => {
      const plain = renderPlain(testPanel());
      expect(plain.some((line) => line.includes("Discover plugins (1/8)"))).toBe(true);
      expect(plain.some((line) => line.includes(pluginName(0)))).toBe(false);
    });
  });

  it("steps back from a browse onto the marketplace detail that opened it", () => {
    const panel = testPanel();
    openTestMarketplaceDetail(panel);
    panel.handleKey(key("return"));
    expect(renderPlain(panel).some((line) => line.includes("Install Plugins"))).toBe(true);

    panel.handleKey(key("escape"));
    const plain = renderPlain(panel);
    expect(plain.some((line) => line.trim().startsWith(MARKETPLACE_NAME))).toBe(true);
    expect(plain.some((line) => line.includes("Browse plugins (9)"))).toBe(true);
  });
});

describe("installed tab skill roster", () => {
  it("keeps built-in skills out of the Installed list while user skills stay", () => {
    registerSkill({
      name: "builtin-probe-skill",
      aliases: [],
      description: "Product-shipped skill.",
      whenToUse: "Never in this list.",
      argumentHint: null,
      userInvocable: true,
      modelInvocable: true,
      context: "inline",
      body: "Built-in body.",
      builtin: true,
      source: "builtin",
      authorModelLock: false,
    });
    try {
      const panel = testPanel(() => {}, 60);
      panel.handleKey(key("tab"));
      const plain = panel.render(100).map(stripAnsi);
      expect(plain.some((line) => line.includes("builtin-probe-skill"))).toBe(false);
      expect(plain.some((line) => line.includes(skillName(0)))).toBe(true);
    } finally {
      replaceSkillSnapshot(skillSnapshot().filter((skill) => skill.name !== "builtin-probe-skill"));
    }
  });
});
