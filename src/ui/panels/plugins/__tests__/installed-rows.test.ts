import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import {
  buildInstalledRows,
  type InstalledItem,
  renderInstalledRowLines,
  sortInstalledItems,
} from "../installed-rows.ts";

const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

function makeSkillItem(
  name: string,
  state: "on" | "name-only" | "user-invocable-only" | "off" = "on",
): Extract<InstalledItem, { type: "skill" }> {
  return {
    type: "skill",
    id: `skill:${name}`,
    name,
    description: `${name} description`,
    whenToUse: "",
    scope: "skills",
    sourceLabel: "built-in",
    state,
    authorLocked: false,
    tokenEstimate: 10,
  };
}

function makeMcpItem(
  name: string,
  options: {
    scope?: string;
    status?: "connected" | "disabled" | "pending" | "needs-auth" | "failed";
    indented?: boolean;
    parentId?: string;
  } = {},
): Extract<InstalledItem, { type: "mcp" }> {
  return {
    type: "mcp",
    id: `mcp:${name}`,
    name,
    scope: options.scope ?? "user",
    status: options.status ?? "connected",
    indented: options.indented ?? false,
    ...(options.parentId ? { parentId: options.parentId } : {}),
  };
}

function makePluginItem(
  name: string,
  options: { scope?: string; isEnabled?: boolean; errorCount?: number } = {},
): Extract<InstalledItem, { type: "plugin" }> {
  return {
    type: "plugin",
    id: `${name}@fixtures`,
    plugin: { name, path: `/fixtures/${name}`, source: "fixtures", manifest: { name } },
    name,
    marketplace: "fixtures",
    scope: options.scope ?? "user",
    isEnabled: options.isEnabled ?? true,
    appliedEnabled: options.isEnabled ?? true,
    errorCount: options.errorCount ?? 0,
  };
}

function rows(...items: InstalledItem[]) {
  return buildInstalledRows(sortInstalledItems(items), {
    favoriteIds: new Set(),
    disusedDays: new Map(),
    showDisabled: false,
  });
}

describe("installed row builder", () => {
  test("failed and needs-auth MCPs move to Needs attention and leave their scope group", () => {
    const out = rows(
      makeMcpItem("zeta", { status: "failed" }),
      makeMcpItem("alpha", { status: "connected" }),
      makeMcpItem("mid", { status: "needs-auth" }),
    );
    const kinds = out.map((row) => row.kind);
    expect(kinds[0]).toBe("section");
    expect(out[0]).toMatchObject({ kind: "section", section: "attention" });
    const attentionItems = out.filter((row) => row.kind === "item" && row.section === "attention");
    expect(attentionItems.map((row) => row.kind === "item" && row.item.name)).toEqual([
      "mid",
      "zeta",
    ]);
    const mainItems = out.filter((row) => row.kind === "item" && row.section === "main");
    expect(mainItems.map((row) => row.kind === "item" && row.item.name)).toEqual(["alpha"]);
  });

  test("errored enabled plugins move to Needs attention; disabled ones fold", () => {
    const out = rows(
      makePluginItem("broken", { errorCount: 2 }),
      makePluginItem("sleepy", { isEnabled: false }),
    );
    const attention = out.filter((row) => row.kind === "item" && row.section === "attention");
    expect(attention.map((row) => row.kind === "item" && row.item.name)).toEqual(["broken"]);
    const fold = out.find((row) => row.kind === "fold");
    expect(fold).toMatchObject({ kind: "fold", disabledCount: 1 });
  });

  test("favorited plugins move to the Favorites section", () => {
    const items = [makePluginItem("star"), makePluginItem("plain")];
    const out = buildInstalledRows(sortInstalledItems(items), {
      favoriteIds: new Set(["star@fixtures"]),
      disusedDays: new Map(),
      showDisabled: false,
    });
    expect(out.some((row) => row.kind === "section" && row.section === "favorites")).toBe(true);
    const favoriteRows = out.filter((row) => row.kind === "item" && row.section === "favorites");
    expect(favoriteRows.map((row) => row.kind === "item" && row.item.name)).toEqual(["star"]);
    const mainRows = out.filter((row) => row.kind === "item" && row.section === "main");
    expect(mainRows.map((row) => row.kind === "item" && row.item.name)).toEqual(["plain"]);
  });

  test("child MCP rows stay indented after their plugin; orphans demote", () => {
    const items = sortInstalledItems([
      makePluginItem("host"),
      makeMcpItem("plugin:host@fixtures:server", { indented: true, parentId: "host@fixtures" }),
    ]);
    const out = buildInstalledRows(items, {
      favoriteIds: new Set(),
      disusedDays: new Map(),
      showDisabled: false,
    });
    const itemRows = out.filter((row) => row.kind === "item");
    expect(itemRows).toHaveLength(2);
    expect(itemRows[1]).toMatchObject({ kind: "item", item: { indented: true } });
  });

  test("skills sort inside the skills scope after scope groups", () => {
    const out = rows(makeSkillItem("beta"), makeMcpItem("alpha"), makeSkillItem("alpha-skill"));
    const scopes = out
      .filter((row) => row.kind === "scope")
      .map((row) => row.kind === "scope" && row.scope);
    expect(scopes).toEqual(["user", "skills"]);
  });
});

describe("installed row rendering", () => {
  test("flows plugin metadata after the type chip without a fixed label column", () => {
    const item = {
      ...makePluginItem("typescript-lsp"),
      activity: { skillCount: 0, totalCount: 1763 },
      unusedDays: 17,
    };
    const line = renderInstalledRowLines(
      { kind: "item", id: item.id, section: "disused", item },
      true,
      false,
      120,
    )[0]!;

    expect(stripAnsi(line)).toBe(
      `${Glyph.chevron}typescript-lsp Plugin · fixtures · ${Glyph.check} enabled · not used in 17 days`,
    );
    expect(line).toContain(
      renderTextWithStyles("Plugin", {
        backgroundColor: Color.inverseBg,
        color: Color.textStrong,
      }),
    );
    expect(line).toContain(renderTextWithStyles(Glyph.check, { color: Color.success }));
    expect(stripAnsi(line)).not.toContain("0 skills");
  });

  test("keeps child MCP branches and colors only the status glyph", () => {
    const item = makeMcpItem("playwright", {
      status: "failed",
      indented: true,
      parentId: "playwright@fixtures",
    });
    const line = renderInstalledRowLines(
      { kind: "item", id: item.id, section: "main", item },
      false,
      false,
      80,
    )[0]!;

    expect(stripAnsi(line)).toBe("  └ playwright MCP · ✘ failed");
    expect(line).toContain(renderTextWithStyles("✘", { color: Color.error }));
  });

  test("insets section and scope headings independently from selectable rows", () => {
    const section = renderInstalledRowLines(
      { kind: "section", id: "section:attention", section: "attention" },
      false,
      false,
      80,
    )[0]!;
    const scope = renderInstalledRowLines(
      { kind: "scope", id: "scope:user", scope: "user" },
      false,
      false,
      80,
    )[0]!;

    expect(stripAnsi(section)).toBe("  Needs attention");
    expect(section).toContain(
      renderTextWithStyles("Needs attention", { bold: true, color: Color.warning }),
    );
    expect(stripAnsi(scope)).toBe("    User");
  });
});
