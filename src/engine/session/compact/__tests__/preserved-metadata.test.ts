import { describe, expect, it } from "bun:test";
import { preserveMetadataForTail } from "@/engine/session/compact/preserved-metadata.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import type { Message } from "@/kernel/std/types/message.ts";

const TS = "2026-01-01T00:00:00.000Z";
const PRESERVED_TAIL: Message[] = [
  { role: "user", content: [{ type: "text", text: "keep user" }] },
  { role: "assistant", content: [{ type: "text", text: "keep assistant" }] },
];

describe("preserveMetadataForTail", () => {
  it("describes a matched stable transcript suffix in both metadata forms", () => {
    const metadata = preserveMetadataForTail(stableRecords(), PRESERVED_TAIL, "boundary");

    expect(metadata).toEqual({
      preservedSegment: {
        headUuid: "keep-user",
        tailUuid: "keep-assistant",
        anchorUuid: "boundary",
      },
      preservedMessages: {
        uuids: ["keep-user", "keep-assistant"],
        anchorUuid: "boundary",
      },
    });
  });

  it("falls back to a hard boundary when a matched participant lacks a uuid", () => {
    const records = stableRecords();
    const assistant = records.at(-1);
    if (assistant?.type !== "assistant_message") throw new Error("expected assistant record");
    delete assistant.uuid;

    expect(preserveMetadataForTail(records, PRESERVED_TAIL, "boundary")).toBeNull();
  });

  it("falls back to a hard boundary when the preserved tail is not a transcript suffix", () => {
    const unmatched: Message[] = [{ role: "user", content: [{ type: "text", text: "different" }] }];

    expect(preserveMetadataForTail(stableRecords(), unmatched, "boundary")).toBeNull();
  });
});

function stableRecords(): SessionRecord[] {
  return [
    { type: "user_message", ts: TS, uuid: "old-user", content: "old" },
    { type: "assistant_message", ts: TS, uuid: "old-assistant", content: "old answer" },
    { type: "user_message", ts: TS, uuid: "keep-user", content: "keep user" },
    {
      type: "assistant_message",
      ts: TS,
      uuid: "keep-assistant",
      content: "keep assistant",
    },
  ];
}
