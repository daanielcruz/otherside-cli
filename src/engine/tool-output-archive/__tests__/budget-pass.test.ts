import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@/kernel/std/types/message.ts";
import {
  createToolOutputArchive,
  enforceToolOutputBudget,
  restoreToolOutputArchive,
} from "../budget-pass.ts";
import { ARCHIVE_NOTICE_OPEN } from "../contract.ts";

let archiveDirectory = "";
let previousArchiveDirectory: string | undefined;

beforeEach(async () => {
  previousArchiveDirectory = process.env.OTHERSIDE_TOOL_RESULTS_DIR;
  archiveDirectory = await mkdtemp(join(tmpdir(), "otherside-tool-output-archive-"));
  process.env.OTHERSIDE_TOOL_RESULTS_DIR = archiveDirectory;
});

afterEach(async () => {
  if (previousArchiveDirectory === undefined) delete process.env.OTHERSIDE_TOOL_RESULTS_DIR;
  else process.env.OTHERSIDE_TOOL_RESULTS_DIR = previousArchiveDirectory;
  await rm(archiveDirectory, { recursive: true, force: true });
});

describe("enforceToolOutputBudget", () => {
  it("archives the largest pending output until the turn fits", async () => {
    const messages = toolOutputTurn([
      { id: "large", name: "Bash", content: "a".repeat(120_000) },
      { id: "medium", name: "Bash", content: "b".repeat(90_000) },
    ]);
    const archive = createToolOutputArchive();

    const result = await enforceToolOutputBudget(messages, archive);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.toolUseId).toBe("large");
    expect(toolResultContent(result.messages, "large")).toStartWith(ARCHIVE_NOTICE_OPEN);
    expect(toolResultContent(result.messages, "medium")).toBe("b".repeat(90_000));
    expect(archive.observedCallIds).toEqual(new Set(["large", "medium"]));
    expect(archive.notices.get("large")).toBe(result.records[0]?.replacement);
  });

  it("excludes Read outputs from the turn budget", async () => {
    const messages = toolOutputTurn([
      { id: "read", name: "Read", content: "a".repeat(150_000) },
      { id: "shell", name: "Bash", content: "b".repeat(90_000) },
    ]);
    const archive = createToolOutputArchive();

    const result = await enforceToolOutputBudget(messages, archive);

    expect(result.messages).toBe(messages);
    expect(result.records).toEqual([]);
    expect(archive.observedCallIds).toEqual(new Set(["read", "shell"]));
  });

  it("reapplies a stable notice without writing a second record", async () => {
    const messages = toolOutputTurn([
      { id: "large", name: "Bash", content: "a".repeat(120_000) },
      { id: "medium", name: "Bash", content: "b".repeat(90_000) },
    ]);
    const archive = createToolOutputArchive();
    const first = await enforceToolOutputBudget(messages, archive);

    const second = await enforceToolOutputBudget(messages, archive);

    expect(second.records).toEqual([]);
    expect(toolResultContent(second.messages, "large")).toBe(first.records[0]?.replacement);
  });
});

describe("restoreToolOutputArchive", () => {
  it("restores records first and inherited notices only as fallback", () => {
    const messages = toolOutputTurn([
      { id: "recorded", name: "Bash", content: "raw" },
      { id: "inherited", name: "Bash", content: "raw" },
      { id: "unrelated", name: "Bash", content: "raw" },
    ]);

    const archive = restoreToolOutputArchive(
      messages,
      [
        {
          kind: "tool-result",
          toolUseId: "recorded",
          replacement: "record notice",
        },
      ],
      new Map([
        ["recorded", "inherited duplicate"],
        ["inherited", "inherited notice"],
        ["missing", "ignored"],
      ]),
    );

    expect(archive.observedCallIds).toEqual(new Set(["recorded", "inherited", "unrelated"]));
    expect(archive.notices).toEqual(
      new Map([
        ["recorded", "record notice"],
        ["inherited", "inherited notice"],
      ]),
    );
  });
});

function toolOutputTurn(outputs: Array<{ id: string; name: string; content: string }>): Message[] {
  return [
    {
      role: "assistant",
      id: "assistant-turn",
      content: outputs.map(({ id, name }) => ({ type: "tool_use", id, name, input: {} })),
    },
    {
      role: "user",
      content: outputs.map(({ id, content }) => ({
        type: "tool_result",
        tool_use_id: id,
        content,
      })),
    },
  ];
}

function toolResultContent(messages: Message[], callId: string): string | undefined {
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const block = message.content.find(
      (candidate) => candidate.type === "tool_result" && candidate.tool_use_id === callId,
    );
    return block?.type === "tool_result" && typeof block.content === "string"
      ? block.content
      : undefined;
  }
  return undefined;
}
