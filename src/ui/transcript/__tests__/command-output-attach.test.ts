import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { renderSettledEntries } from "@/ui/transcript/entry-lines.ts";

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
