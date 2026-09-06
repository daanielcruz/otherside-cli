import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "@/kernel/std/fs/paths.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { formatHint, hintFor } from "@/ui/chrome/panel-hints.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { createResumePanel } from "../string-view.ts";

/** Rows the string-view shell (prompt frame, status rows) keeps beneath a panel. */
const SHELL_ROWS = 7;
const WIDTH = 80;
const SESSION_COUNT = 30;

let previousConfigDir: string | undefined;
let previousEphemeralDir: string | undefined;
let configDir: string;
let panels: StringViewPanel[];

beforeEach(() => {
  previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  previousEphemeralDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-resume-panel-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = join(configDir, "ephemeral-sessions");

  const projectDir = join(configDir, "projects", projectSlug(process.cwd()));
  mkdirSync(projectDir, { recursive: true });
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    writeFileSync(
      join(projectDir, `fixture-session-${String(index).padStart(2, "0")}.jsonl`),
      `${JSON.stringify({
        type: "user",
        cwd: "/tmp/fixture-project",
        message: { content: [{ type: "text", text: `Fixture prompt ${index}` }] },
      })}\n`,
    );
  }
  panels = [];
});

afterEach(() => {
  for (const panel of panels) panel.unmount?.();
  if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
  if (previousEphemeralDir === undefined) delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  else process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = previousEphemeralDir;
  rmSync(configDir, { recursive: true, force: true });
});

function mountedPanel(terminalRows: () => number): StringViewPanel {
  const panel = createResumePanel(() => {});
  panel.mount?.({ requestRender() {}, pushFocus() {}, popFocus() {}, terminalRows });
  panels.push(panel);
  return panel;
}

describe("resume panel height budget", () => {
  it("stays within the body budget of a short terminal", () => {
    const lines = mountedPanel(() => 20).render(WIDTH);

    expect(lines.length).toBeLessThanOrEqual(20 - SHELL_ROWS);
  });

  it("caps its window in a tall terminal instead of filling the screen", () => {
    const tall = mountedPanel(() => 60).render(WIDTH);
    const taller = mountedPanel(() => 100).render(WIDTH);

    expect(tall.length).toBeLessThanOrEqual(60 - SHELL_ROWS);
    // The compact cap, not the terminal height, bounds the panel once it is tall.
    expect(taller.length).toBe(tall.length);
  });

  it("marks hidden sessions with a counted overflow marker from the window policy", () => {
    const lines = mountedPanel(() => 24)
      .render(WIDTH)
      .map(stripAnsi);

    expect(lines.some((line) => /↓ \d+ more below$/.test(line.trim()))).toBe(true);
    expect(lines.some((line) => line.includes("fixture-session-"))).toBe(true);
  });

  it("keeps the search box and dictionary-phrased hints inside the budget", () => {
    const lines = mountedPanel(() => 40)
      .render(WIDTH)
      .map(stripAnsi);

    expect(lines.some((line) => line.includes("Search…"))).toBe(true);
    expect(lines.some((line) => line.includes(formatHint(hintFor("typeToSearch"))))).toBe(true);
    expect(lines.some((line) => line.includes(formatHint(hintFor("cancel"))))).toBe(true);
  });
});

/**
 * The picker's own list mode seeds its search on typed characters, so only the keys
 * it declines reach the shared list vocabulary: the chords and the edge keys.
 */
describe("resume panel shared list keys", () => {
  const key = (name: string, overrides: Record<string, unknown> = {}) =>
    ({ name, ctrl: false, meta: false, ...overrides }) as Parameters<
      NonNullable<StringViewPanel["handleKey"]>
    >[0];

  /** The session row the cursor points at; the command bar carries the same chevron. */
  const selectedRow = (panel: StringViewPanel): string => {
    const row = panel
      .render(WIDTH)
      .map(stripAnsi)
      .find((line) => line.trimStart().startsWith("❯") && !line.includes("/resume"));
    return (row ?? "").replace("❯", "").trim();
  };

  it("steps with ctrl+n and ctrl+p", () => {
    const panel = mountedPanel(() => 40);
    const first = selectedRow(panel);
    expect(first).toContain("fixture-session-");

    panel.handleKey(key("n", { ctrl: true }));
    const second = selectedRow(panel);
    expect(second).not.toBe(first);

    panel.handleKey(key("p", { ctrl: true }));
    expect(selectedRow(panel)).toBe(first);
  });

  it("reaches both ends with home/end", () => {
    const panel = mountedPanel(() => 40);
    const first = selectedRow(panel);

    panel.handleKey(key("end"));
    const last = selectedRow(panel);
    expect(last).not.toBe(first);
    expect(last).toContain("fixture-session-");

    panel.handleKey(key("home"));
    expect(selectedRow(panel)).toBe(first);
  });

  it("leaves typed letters to the search box they seed", () => {
    const panel = mountedPanel(() => 40);
    panel.handleKey(key("j", { sequence: "j" }));

    const rows = panel.render(WIDTH).map(stripAnsi);
    expect(rows.some((line) => line.includes("j"))).toBe(true);
    expect(selectedRow(panel)).toBe("");
  });
});
