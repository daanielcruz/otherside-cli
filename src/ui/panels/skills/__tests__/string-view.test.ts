import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { clear as clearSkills, register, type Skill } from "@/engine/skills/registry.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { formatHint, hintFor } from "@/ui/chrome/panel-hints.ts";
import { formatTokenEstimate, skillTokenEstimate } from "@/ui/panels/skills/rows.ts";
import { createSkillsPanel } from "@/ui/panels/skills/string-view.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Glyph } from "@/ui/theme/theme.ts";

const WIDTH = 100;
const TERMINAL_ROWS = 40;

const originalColorLevel = chalk.level;
let previousConfigDir: string | undefined;
let configDir: string;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

beforeEach(() => {
  previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-skills-panel-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  clearSkills();
});

afterEach(() => {
  clearSkills();
  if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

const skill = (overrides: Partial<Skill> & { name: string }): Skill => ({
  aliases: [],
  description: "",
  whenToUse: "",
  argumentHint: null,
  userInvocable: true,
  modelInvocable: true,
  context: "inline",
  body: "",
  builtin: false,
  source: "user",
  authorModelLock: false,
  ...overrides,
});

const key = (name: string | undefined, overrides: Partial<KeyEventData> = {}): KeyEventData => ({
  kind: "key",
  fn: false,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence: undefined,
  raw: undefined,
  isPasted: false,
  ...overrides,
});

const mountedPanel = (rows = TERMINAL_ROWS): StringViewPanel => {
  const panel = createSkillsPanel(() => {});
  panel.mount?.({
    requestRender() {},
    pushFocus() {},
    popFocus() {},
    terminalRows: () => rows,
  });
  return panel;
};

const plainLines = (panel: StringViewPanel, width = WIDTH): string[] =>
  panel.render(width).map(stripAnsi);

const lineContaining = (panel: StringViewPanel, needle: string): string => {
  const line = plainLines(panel).find((row) => row.includes(needle));
  expect(line).toBeDefined();
  return line!;
};

/** Rows carrying a token estimate — the skill rows, never the chrome around them. */
const skillRows = (panel: StringViewPanel): string[] =>
  plainLines(panel).filter((line) => /\stok(\s|$)/.test(line));

describe("skills panel list", () => {
  beforeEach(() => {
    register(skill({ name: "alpha-tool", description: "Analyze alpha telemetry", source: "user" }));
    register(skill({ name: "beta-report", description: "Beta release report", source: "project" }));
    register(
      skill({
        name: "gamma-builtin",
        description: "A built-in skill with a longer description used for the token estimate",
        source: "builtin",
        builtin: true,
      }),
    );
  });

  it("titles the panel and counts the skills", () => {
    const lines = plainLines(mountedPanel());
    expect(lines.some((line) => line.includes("Skills"))).toBe(true);
    expect(lines.some((line) => line.trim() === "3 skills")).toBe(true);
  });

  it("renders one flowing row per skill: state, name, source and token estimate", () => {
    const row = lineContaining(mountedPanel(), "alpha-tool");
    const estimate = formatTokenEstimate(
      skillTokenEstimate(
        skill({ name: "alpha-tool", description: "Analyze alpha telemetry", source: "user" }),
      ),
    );
    expect(row).toContain(`alpha-tool · user · ${estimate} tok`);
  });

  it("collapses the built-in source to `built-in`", () => {
    expect(lineContaining(mountedPanel(), "gamma-builtin")).toContain("· built-in ·");
  });

  it("marks only the cursor row with the selection chevron", () => {
    const panel = mountedPanel();
    expect(skillRows(panel).filter((line) => line.includes("❯")).length).toBe(1);
  });

  it("hangs the rows flush off the search box, with the box set off above", () => {
    const lines = plainLines(mountedPanel());
    const boxBottom = lines.findIndex((line) => line.trim().startsWith("╰"));
    const boxTop = lines.findIndex((line) => line.trim().startsWith("╭"));
    expect(lines[boxTop - 1]?.trim()).toBe("");
    expect(lines[boxTop - 2]?.trim()).toBe("3 skills");
    expect(lines[boxBottom + 1]).toContain("gamma-builtin");
  });

  it("offers the list hints in the shared hint vocabulary", () => {
    const hints = lineContaining(mountedPanel(), "to cycle");
    expect(hints).toContain(formatHint(hintFor("cycle")));
    expect(hints).toContain(formatHint(hintFor("search")));
    expect(hints).toContain(formatHint(hintFor("sort")));
    expect(hints).toContain(formatHint(hintFor("close")));
    expect(hints).not.toContain("navigate");
  });

  it("orders by source then name, and by token cost once `t` is pressed", () => {
    const panel = mountedPanel();
    const names = (): string[] =>
      skillRows(panel).map((line) => (line.split(" · ")[0] ?? "").trim().split(/\s+/).at(-1) ?? "");
    expect(names()).toEqual(["gamma-builtin", "beta-report", "alpha-tool"]);

    panel.handleKey(key(undefined, { sequence: "t" }));
    expect(plainLines(panel).some((line) => line.includes("sorted by tokens"))).toBe(true);
    expect(names()[0]).toBe("gamma-builtin");
  });
});

describe("skills panel search", () => {
  beforeEach(() => {
    register(skill({ name: "alpha-tool", description: "Analyze alpha telemetry" }));
    register(skill({ name: "beta-report", description: "Beta release report" }));
  });

  it("counts filtered over total once a query is typed", () => {
    const panel = mountedPanel();
    panel.handleKey(key(undefined, { sequence: "/" }));
    for (const character of "beta") panel.handleKey(key(undefined, { sequence: character }));
    expect(plainLines(panel).some((line) => line.trim() === "2/2 skills")).toBe(false);
    expect(plainLines(panel).some((line) => line.trim() === "1/2 skills")).toBe(true);
    expect(plainLines(panel).some((line) => line.includes("alpha-tool"))).toBe(false);
  });

  it("says so when nothing matches, and drops to the search-exit hints", () => {
    const panel = mountedPanel();
    panel.handleKey(key(undefined, { sequence: "/" }));
    for (const character of "zzz") panel.handleKey(key(undefined, { sequence: character }));
    expect(plainLines(panel).some((line) => line.includes('No skills match "zzz"'))).toBe(true);
  });

  it("sets the no-match line off from the search box with a blank row", () => {
    const panel = mountedPanel();
    panel.handleKey(key(undefined, { sequence: "/" }));
    for (const character of "zzz") panel.handleKey(key(undefined, { sequence: character }));
    const lines = plainLines(panel);
    const index = lines.findIndex((line) => line.includes('No skills match "zzz"'));
    expect(lines[index - 1]?.trim()).toBe("");
    expect(lines[index - 2]?.trim().startsWith("╰")).toBe(true);
  });

  it("offers the search hints in the shared hint vocabulary", () => {
    const panel = mountedPanel();
    panel.handleKey(key(undefined, { sequence: "/" }));
    const hints = lineContaining(panel, "to filter");
    expect(hints).toContain(formatHint(hintFor("typeToFilter")));
    expect(hints).toContain(formatHint(hintFor("select")));
    expect(hints).toContain(formatHint(hintFor("clear")));
  });

  it("keeps `t` a sort key instead of a filter seed", () => {
    const panel = mountedPanel();
    panel.handleKey(key(undefined, { sequence: "t" }));
    expect(plainLines(panel).some((line) => line.trim() === "2 skills · sorted by tokens")).toBe(
      true,
    );
  });
});

describe("skills panel locks", () => {
  it("locks a plugin skill and names the authority", () => {
    register(skill({ name: "vendor-skill", source: "plugin", description: "From a plugin" }));
    expect(lineContaining(mountedPanel(), "vendor-skill")).toContain("· locked by plugin");
    expect(
      plainLines(mountedPanel()).some((line) =>
        line.includes("Plugin skills are managed via /plugins"),
      ),
    ).toBe(true);
  });

  it("locks a skill whose frontmatter opts out of model invocation", () => {
    register(skill({ name: "author-locked", authorModelLock: true }));
    const row = lineContaining(mountedPanel(), "author-locked");
    expect(row).toContain("user-only");
    expect(row).toContain("· locked by author");
  });

  it("leaves a locked row's state untouched when Enter is pressed", () => {
    register(skill({ name: "vendor-skill", source: "plugin" }));
    const panel = mountedPanel();
    const before = lineContaining(panel, "vendor-skill");
    panel.handleKey(key("return"));
    expect(lineContaining(panel, "vendor-skill")).toBe(before);
  });
});

describe("skills panel empty state", () => {
  it("names the directories a skill is read from", () => {
    const lines = plainLines(mountedPanel());
    expect(lines.some((line) => line.includes("No skills found"))).toBe(true);
    expect(
      lines.some((line) =>
        line.includes("Create skills in .otherside/skills/ or ~/.otherside/skills/"),
      ),
    ).toBe(true);
  });
});

describe("skills panel window", () => {
  beforeEach(() => {
    for (let index = 0; index < 40; index++) {
      register(skill({ name: `skill-${String(index).padStart(2, "0")}` }));
    }
  });

  it("fits the frame in the terminal and counts the rows it hid", () => {
    const panel = mountedPanel(24);
    const lines = panel.render(WIDTH);
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(plainLines(panel).some((line) => line.includes("more below"))).toBe(true);
  });

  it("keeps fitting after a resize", () => {
    const rows = { value: 40 };
    const panel = createSkillsPanel(() => {});
    panel.mount?.({
      requestRender() {},
      pushFocus() {},
      popFocus() {},
      terminalRows: () => rows.value,
    });
    expect(panel.render(WIDTH).length).toBeLessThanOrEqual(40);
    rows.value = 16;
    expect(panel.render(60).length).toBeLessThanOrEqual(16);
    rows.value = 50;
    expect(panel.render(120).length).toBeLessThanOrEqual(50);
  });

  it("shows the rows above the window once the cursor walks past it", () => {
    const panel = mountedPanel(24);
    for (let step = 0; step < 30; step++) panel.handleKey(key("down"));
    expect(plainLines(panel).some((line) => line.includes("more above"))).toBe(true);
  });
});

describe("skills panel shared list keys", () => {
  beforeEach(() => {
    for (let index = 0; index < 40; index++) {
      register(skill({ name: `skill-${String(index).padStart(2, "0")}` }));
    }
  });

  /** The name on the row the cursor points at; the row marks it with the chevron. */
  const selectedSkill = (panel: StringViewPanel): string => {
    const row = skillRows(panel).find((line) => line.trimStart().startsWith(Glyph.chevron));
    return (row ?? "").split("·")[0]?.trim() ?? "";
  };

  it("steps with ctrl+n and ctrl+p once the search box has passed on the key", () => {
    const panel = mountedPanel(40);
    const first = selectedSkill(panel);

    panel.handleKey(key("n", { ctrl: true }));
    const second = selectedSkill(panel);
    expect(second).not.toBe(first);

    panel.handleKey(key("p", { ctrl: true }));
    expect(selectedSkill(panel)).toBe(first);
  });

  it("reaches the ends with home/end and pages with the page keys", () => {
    const panel = mountedPanel(40);
    panel.handleKey(key("end"));
    expect(selectedSkill(panel)).toContain("skill-39");

    panel.handleKey(key("home"));
    const first = selectedSkill(panel);

    panel.handleKey(key("pagedown"));
    const paged = selectedSkill(panel);
    expect(paged).not.toBe(first);

    panel.handleKey(key("down"));
    panel.handleKey(key("up"));
    expect(selectedSkill(panel)).toBe(paged);

    panel.handleKey(key("pageup"));
    expect(selectedSkill(panel)).toBe(first);
  });

  it("still seeds the filter when a letter is typed, rather than navigating", () => {
    const panel = mountedPanel(40);
    panel.handleKey(key("z", { sequence: "z" }));
    expect(plainLines(panel).some((line) => line.includes('No skills match "z"'))).toBe(true);
  });
});
