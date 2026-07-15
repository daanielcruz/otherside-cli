import { describe, expect, test } from "bun:test";
import {
  foreignMainChainHead,
  reconstructForeignConversation,
} from "@/engine/session/conversation-chain.ts";

interface LineSpec {
  uuid: string;
  parentUuid: string | null;
  type: "user" | "assistant" | "summary" | "system";
  ts: string;
  sidechain?: boolean;
  messageId?: string;
  toolResult?: boolean;
  agentId?: string;
  subtype?: string;
}

function line(spec: LineSpec): string {
  const message: Record<string, unknown> = {};
  if (spec.messageId !== undefined) message.id = spec.messageId;
  if (spec.toolResult) message.content = [{ type: "tool_result", tool_use_id: "t", content: "" }];
  const obj: Record<string, unknown> = {
    type: spec.type,
    uuid: spec.uuid,
    parentUuid: spec.parentUuid,
    timestamp: spec.ts,
    message,
  };
  if (spec.sidechain) obj.isSidechain = true;
  if (spec.agentId !== undefined) obj.agentId = spec.agentId;
  if (spec.subtype !== undefined) obj.subtype = spec.subtype;
  return JSON.stringify(obj);
}

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function uuids(chain: Record<string, unknown>[] | null): string[] {
  return (chain ?? []).map((raw) => raw.uuid as string);
}

describe("reconstructForeignConversation", () => {
  test("returns null for a native otherside file (carries _os)", () => {
    const native = JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp: at(0),
      _os: { type: "user_message" },
      message: { role: "user", content: [] },
    });
    expect(reconstructForeignConversation([native], { sidechain: false })).toBeNull();
  });

  test("walks a linear foreign chain in root-to-leaf order", () => {
    const lines = [
      line({ uuid: "u1", parentUuid: null, type: "user", ts: at(0) }),
      line({ uuid: "a1", parentUuid: "u1", type: "assistant", ts: at(1) }),
      line({ uuid: "u2", parentUuid: "a1", type: "user", ts: at(2) }),
    ];
    expect(uuids(reconstructForeignConversation(lines, { sidechain: false }))).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
  });

  test("prunes an abandoned branch (rewind orphan) via the leaf walk", () => {
    const lines = [
      line({ uuid: "u1", parentUuid: null, type: "user", ts: at(0) }),
      line({ uuid: "aOld", parentUuid: "u1", type: "assistant", ts: at(1) }),
      line({ uuid: "aNew", parentUuid: "u1", type: "assistant", ts: at(2) }),
      line({ uuid: "u2", parentUuid: "aNew", type: "user", ts: at(3) }),
    ];
    expect(uuids(reconstructForeignConversation(lines, { sidechain: false }))).toEqual([
      "u1",
      "aNew",
      "u2",
    ]);
  });

  test("terminates on a parentUuid cycle and returns a partial chain", () => {
    const lines = [
      line({ uuid: "u1", parentUuid: "u2", type: "user", ts: at(0) }),
      line({ uuid: "u2", parentUuid: "u1", type: "user", ts: at(1) }),
    ];
    const chain = reconstructForeignConversation(lines, { sidechain: false });
    expect(uuids(chain).sort()).toEqual(["u1", "u2"]);
  });

  test("stitches the chain by timestamp when parentUuid does not resolve", () => {
    const lines = [
      line({ uuid: "u1", parentUuid: null, type: "user", ts: at(0) }),
      line({ uuid: "a1", parentUuid: "MISSING", type: "assistant", ts: at(1) }),
    ];
    expect(uuids(reconstructForeignConversation(lines, { sidechain: false }))).toEqual([
      "u1",
      "a1",
    ]);
  });

  test("does not stitch a timestamp neighbor outside the fallback window", () => {
    const lines = [
      line({ uuid: "u1", parentUuid: null, type: "user", ts: at(0) }),
      line({ uuid: "a1", parentUuid: "MISSING", type: "assistant", ts: at(10) }),
    ];
    expect(uuids(reconstructForeignConversation(lines, { sidechain: false }))).toEqual(["a1"]);
  });

  test("selects the sidechain true-leaf and prunes the abandoned sidechain branch", () => {
    const lines = [
      line({ uuid: "s1", parentUuid: null, type: "user", ts: at(0), sidechain: true }),
      line({ uuid: "s2a", parentUuid: "s1", type: "assistant", ts: at(1), sidechain: true }),
      line({ uuid: "s2b", parentUuid: "s1", type: "assistant", ts: at(2), sidechain: true }),
      line({ uuid: "ignored", parentUuid: null, type: "user", ts: at(3) }),
    ];
    expect(uuids(reconstructForeignConversation(lines, { sidechain: true }))).toEqual([
      "s1",
      "s2b",
    ]);
  });

  test("recovers orphaned parallel tool_result siblings (DAG)", () => {
    const lines = [
      line({ uuid: "u1", parentUuid: null, type: "user", ts: at(0) }),
      line({ uuid: "aA", parentUuid: "u1", type: "assistant", ts: at(1), messageId: "m1" }),
      line({ uuid: "aB", parentUuid: "u1", type: "assistant", ts: at(2), messageId: "m1" }),
      line({ uuid: "trA", parentUuid: "aA", type: "user", ts: at(3), toolResult: true }),
      line({ uuid: "trB", parentUuid: "aB", type: "user", ts: at(4), toolResult: true }),
    ];
    expect(uuids(reconstructForeignConversation(lines, { sidechain: false }))).toEqual([
      "u1",
      "aB",
      "aA",
      "trA",
      "trB",
    ]);
  });
});

describe("foreignMainChainHead", () => {
  test("returns the active leaf uuid for a foreign file", () => {
    const lines = [
      line({ uuid: "u1", parentUuid: null, type: "user", ts: at(0) }),
      line({ uuid: "a1", parentUuid: "u1", type: "assistant", ts: at(1) }),
      line({ uuid: "u2", parentUuid: "a1", type: "user", ts: at(2) }),
    ];
    expect(foreignMainChainHead(lines)).toBe("u2");
  });

  test("returns null for a native otherside file", () => {
    const native = JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp: at(0),
      _os: { type: "user_message" },
      message: { role: "user", content: [] },
    });
    expect(foreignMainChainHead([native])).toBeNull();
  });
});
