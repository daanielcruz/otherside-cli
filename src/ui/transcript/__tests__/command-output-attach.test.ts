import { describe, expect, it } from "bun:test";
import { register, replaceSnapshot, snapshot } from "@/engine/skills/registry.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { renderSettledEntries } from "@/ui/transcript/entry-lines.ts";
import { SettledScrollbackArchive } from "@/ui/transcript/scrollback-archive.ts";
import type { SettledEntry } from "@/ui/transcript/settled-entry.ts";
import { mapTranscriptEntries } from "@/ui/transcript/string-view-store.ts";

/**
 * Regression: the fork feedback opened its own block, leaving a blank margin
 * between the command echo and the gutter. A command's output is a gutter
 * continuation of the echo above it — glyph head, no separating blank.
 */
describe("command output presentation", () => {
  it("hugs the command echo with the gutter head and no blank margin", () => {
    const feedback = [
      "forked into a background agent · sample-fork (ab12)",
      "it carries this conversation up to now and is already working · nothing here changes",
      "track it in the agents panel (↓ to manage) · its result lands here as a notification when it completes",
    ].join("\n");
    const rows = renderSettledEntries(
      120,
      [
        { kind: "user", text: "/fork sample directive", images: [] },
        { kind: "command_output", text: feedback },
      ],
      "compact",
    ).map(stripAnsi);

    const echoIndex = rows.findIndex((row) => row.includes("/fork sample directive"));
    expect(echoIndex).toBeGreaterThanOrEqual(0);
    const next = rows[echoIndex + 1] ?? "";
    expect(next.startsWith(GUTTER_HEAD)).toBe(true);
    expect(next).toContain("forked into a background agent");
  });
});

const skillEntry: Extract<SettledEntry, { kind: "skill" }> = {
  kind: "skill",
  skillName: "fixture",
  text: "",
  isError: false,
};
const userEntry: Extract<SettledEntry, { kind: "user" }> = {
  kind: "user",
  text: "/fixture sample arguments",
};

describe("skill command attachment", () => {
  it("keeps appended archive rows identical to a complete reflow", () => {
    const prefix: SettledEntry[] = [
      userEntry,
      { kind: "thinking", text: "Detailed reasoning.", detailOnly: true },
    ];
    const archive = new SettledScrollbackArchive();
    archive.setSettled(prefix);
    const first = archive.takeBatch(100, "compact");
    expect(first.mode).toBe("reflow");
    if (first.mode === "idle") throw new Error("expected initial archive rows");
    archive.setSettled([...prefix, skillEntry]);
    const next = archive.takeBatch(100, "compact");
    expect(next.mode).toBe("add");
    if (next.mode === "idle") throw new Error("expected appended skill rows");
    expect(stripAnsi(next.rows[0] ?? "")).toBe(`${GUTTER_HEAD}Initializing…`);
    expect([...first.rows, ...next.rows]).toEqual(
      renderSettledEntries(100, [...prefix, skillEntry], "compact"),
    );
    expect(archive.takeBatch(60, "compact")).toEqual({
      mode: "reflow",
      rows: renderSettledEntries(60, [...prefix, skillEntry], "compact"),
    });
  });

  it("uses the visible prefix at a sliced render boundary", () => {
    const rows = renderSettledEntries(100, [skillEntry], "compact", [
      userEntry,
      { kind: "thinking", text: "Detailed reasoning.", detailOnly: true },
    ]).map(stripAnsi);
    expect(rows[0]).toBe(`${GUTTER_HEAD}Initializing…`);
  });
  it.each([
    100, 60, 20,
  ])("keeps initialization directly beneath its wrapped command at width %i", (width) => {
    const rows = renderSettledEntries(width, [userEntry, skillEntry], "compact").map(stripAnsi);
    const userHeight = renderSettledEntries(width, [userEntry], "compact").length;
    expect(rows[userHeight]).toBe(`${GUTTER_HEAD}Initializing…`);
  });

  it.each(["running", "ok", "error"] as const)("keeps %s tool progress attached", (status) => {
    const entries = mapTranscriptEntries([
      { id: "user-fixture", kind: "user", text: userEntry.text },
      {
        id: "skill-fixture",
        ...skillEntry,
        progress: [{ kind: "tool", toolName: "Read", args: { file_path: "fixture.txt" }, status }],
      },
    ]);
    expect(entries[1]).toMatchObject({ skillName: "fixture" });
    const rows = renderSettledEntries(100, entries, "compact").map(stripAnsi);
    expect(rows[2]).toBe(`${GUTTER_HEAD}Read(fixture.txt)`);
  });

  it("recognizes an alias only through the registered skill", () => {
    const prior = snapshot();
    try {
      register({
        name: "fixture",
        aliases: ["fixture-alias"],
        description: "",
        whenToUse: "",
        argumentHint: null,
        userInvocable: true,
        modelInvocable: true,
        context: "fork",
        body: "Fixture only.",
        builtin: false,
        source: "project",
        authorModelLock: false,
      });
      const rows = renderSettledEntries(
        100,
        [{ kind: "user", text: "/fixture-alias" }, skillEntry],
        "compact",
      ).map(stripAnsi);
      expect(rows[2]).toBe(`${GUTTER_HEAD}Initializing…`);
    } finally {
      replaceSnapshot(prior);
    }
  });

  it.each(["/fixture-more", "plain text", "/other"])("keeps a separate block after %s", (text) => {
    const rows = renderSettledEntries(100, [{ kind: "user", text }, skillEntry], "compact").map(
      stripAnsi,
    );
    expect(rows[2]).toBe("");
    expect(rows[3]).toBe(`${GUTTER_HEAD}Initializing…`);
  });

  it("does not infer the owning skill from an internal tool", () => {
    const rows = renderSettledEntries(
      100,
      [
        userEntry,
        {
          kind: "skill",
          text: "",
          isError: false,
          progress: [
            { kind: "tool", toolName: "Skill", args: { skill: "fixture" }, status: "error" },
          ],
        },
      ],
      "compact",
    ).map(stripAnsi);
    expect(rows[2]).toBe("");
  });

  it("keeps a first skill and a final bullet as separate blocks", () => {
    expect(renderSettledEntries(100, [skillEntry], "compact")[0]).toBe("");
    const rows = renderSettledEntries(
      100,
      [userEntry, { ...skillEntry, text: "Fixture complete." }],
      "compact",
    ).map(stripAnsi);
    expect(rows[2]).toBe("");
    expect(rows[3]).toContain("Fixture complete.");
  });

  it("checks the previous visible entry rather than hidden detailed thinking", () => {
    const entries: SettledEntry[] = [
      userEntry,
      { kind: "thinking", text: "Detailed reasoning.", detailOnly: true },
      skillEntry,
    ];
    const compact = renderSettledEntries(100, entries, "compact").map(stripAnsi);
    expect(compact[2]).toBe(`${GUTTER_HEAD}Initializing…`);
    const detailed = renderSettledEntries(100, entries, "detailed").map(stripAnsi);
    expect(detailed[detailed.indexOf(`${GUTTER_HEAD}Initializing…`) - 1]).toBe("");
  });

  it("does not cross an independent visible entry", () => {
    const rows = renderSettledEntries(
      100,
      [userEntry, { kind: "assistant", text: "Independent message." }, skillEntry],
      "compact",
    ).map(stripAnsi);
    expect(rows[rows.indexOf(`${GUTTER_HEAD}Initializing…`) - 1]).toBe("");
  });
});
