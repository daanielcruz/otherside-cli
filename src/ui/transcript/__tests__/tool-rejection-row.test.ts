import { beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { INTERRUPTED_FEEDBACK } from "@/engine/queue/runtime/interruption-text.ts";
import {
  USER_REJECTED_TOOL_RESULT,
  USER_REJECTED_WITH_FEEDBACK_PREFIX,
} from "@/engine/queue/runtime/rejection-text.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { PERMISSION_DENIED_MESSAGE } from "@/engine/tools/pipeline.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { formatToolLines } from "@/ui/transcript/string-view-tool.ts";
import { buildToolEntryData } from "@/ui/transcript/tool-entry-data.ts";
import { TOOL_USE_REJECTED_LABEL } from "@/ui/transcript/tool-render/rejected.ts";

beforeAll(() => {
  registerAllBuiltins();
});

/** The settled row of a call whose result is `result`, as the transcript shows it. */
function settledRow(name: string, args: unknown, result: string): string[] {
  const entry: TranscriptEntry = {
    id: "r_call",
    kind: "tool",
    title: name,
    input: JSON.stringify(args),
    text: result,
    isError: true,
  };
  const data = buildToolEntryData(entry);
  if (!data) throw new Error("the row was not built");
  return formatToolLines(data, 100).map((line) => stripAnsi(line).trimEnd());
}

const inCwd = (file: string): string => join(process.cwd(), file);

describe("the row of a call the user rejected", () => {
  it("reads as interrupted when the rejection ended the turn", () => {
    const rows = settledRow("Bash", { command: "<command>" }, USER_REJECTED_TOOL_RESULT);

    expect(rows[1]).toContain(INTERRUPTED_FEEDBACK);
    expect(rows).toHaveLength(2);
  });

  it("reads as rejected when the user gave directions", () => {
    const rows = settledRow(
      "Bash",
      { command: "<command>" },
      `${USER_REJECTED_WITH_FEEDBACK_PREFIX}<directions>`,
    );

    expect(rows[1]).toContain(TOOL_USE_REJECTED_LABEL);
    expect(rows.join("\n")).not.toContain("<directions>");
  });

  it("shows the content a rejected Write would have written, numbered", () => {
    const rows = settledRow(
      "Write",
      { file_path: inCwd("<file>.txt"), content: "<first>\n<second>\n" },
      USER_REJECTED_TOOL_RESULT,
    );

    expect(rows.slice(1)).toEqual([
      expect.stringContaining("User rejected write to <file>.txt"),
      expect.stringMatching(/ 1 <first>$/),
      expect.stringMatching(/ 2 <second>$/),
    ]);
  });

  it("shows the change a rejected Edit would have made", () => {
    const rows = settledRow(
      "Edit",
      { file_path: inCwd("<file>.txt"), old_string: "<before>", new_string: "<after>" },
      `${USER_REJECTED_WITH_FEEDBACK_PREFIX}<directions>`,
    );

    expect(rows.some((row) => row.includes("User rejected update to <file>.txt"))).toBe(true);
    expect(rows.some((row) => row.includes("<before>"))).toBe(true);
    expect(rows.some((row) => row.includes("<after>"))).toBe(true);
  });

  it("keeps a rule's denial as an error", () => {
    const rows = settledRow("Bash", { command: "<command>" }, PERMISSION_DENIED_MESSAGE);

    expect(rows[1]).toContain(`Error: ${PERMISSION_DENIED_MESSAGE}`);
  });
});
