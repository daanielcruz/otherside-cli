import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import { askGroup, clear as clearQuestions } from "@/kernel/channels/ask.ts";
import {
  ask as askPermission,
  clear as clearPermissionQueue,
} from "@/kernel/channels/permission.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { Glyph } from "@/ui/theme/theme.ts";
import { formatToolLines } from "@/ui/transcript/string-view-tool.ts";
import { buildToolEntryData } from "@/ui/transcript/tool-entry-data.ts";

beforeAll(() => {
  registerAllBuiltins();
});

afterEach(() => {
  clearPermissionQueue();
  clearQuestions();
});

/** The live row of a Bash call dispatched a minute ago, in a blank phase of its pulse. */
function liveBashRow(): string[] {
  const entry: TranscriptEntry = {
    id: "t_call",
    kind: "tool",
    title: "Bash",
    text: JSON.stringify({ command: "<command>" }),
    startedAt: Date.now() - 60_700,
  };
  const data = buildToolEntryData(entry);
  if (!data) throw new Error("the row was not built");
  return formatToolLines(data, 100).map((line) => stripAnsi(line).trimEnd());
}

describe("the live row of a call", () => {
  it("reads as waiting, with a steady bullet, while a permission prompt is open", () => {
    void askPermission({ toolName: "Bash", argsPreview: "", rule: null });

    const rows = liveBashRow();

    expect(rows[0]).toStartWith(`${Glyph.bullet} Bash(<command>)`);
    expect(rows.slice(1)).toEqual([expect.stringMatching(/ Waiting…$/)]);
  });

  it("reads as waiting while a question panel is open", () => {
    void askGroup([]);

    expect(liveBashRow().slice(1)).toEqual([expect.stringMatching(/ Waiting…$/)]);
  });

  it("reads as running once nothing waits on the user", () => {
    const rows = liveBashRow();

    expect(rows[1]).toContain("Running… (1m 0s)");
  });
});
