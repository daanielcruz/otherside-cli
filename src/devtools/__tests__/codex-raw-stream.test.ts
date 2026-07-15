import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  codexRawReplayHasRequestRole,
  codexRawReplayStreamNeedsPrewarm,
  nextCodexRawOutboundFrame,
  recordCodexRawFrame,
  recordCodexRawLifecycle,
  releaseCodexRawPrimaryReplayTurn,
  waitForCodexRawPrimaryReplayTurn,
} from "@/devtools/codex-raw-stream.ts";

const roots: string[] = [];
const savedCapturePath = process.env.OTHERSIDE_CODEX_RAW_STREAM_CAPTURE;
const savedReplayPath = process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY;

interface ParsedRecord {
  header: Record<string, unknown>;
  payload: Buffer;
}

afterEach(() => {
  delete process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY;
  nextCodexRawOutboundFrame();
  if (savedCapturePath === undefined) delete process.env.OTHERSIDE_CODEX_RAW_STREAM_CAPTURE;
  else process.env.OTHERSIDE_CODEX_RAW_STREAM_CAPTURE = savedCapturePath;
  if (savedReplayPath === undefined) delete process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY;
  else process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY = savedReplayPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex raw stream capture", () => {
  it("does nothing when the capture path is absent", () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "capture.raw");
    delete process.env.OTHERSIDE_CODEX_RAW_STREAM_CAPTURE;

    recordCodexRawFrame(Buffer.from("not-written"), {
      connectionId: "connection-off",
      streamId: "stream-off",
      sessionId: "session-off",
      direction: "inbound",
      isBinary: false,
    });
    recordCodexRawLifecycle("socket_open", {
      connectionId: "connection-off",
      sessionId: "session-off",
    });

    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.lifecycle.jsonl`)).toBe(false);
  });

  it("preserves frame bytes and replay metadata", () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "capture.raw");
    process.env.OTHERSIDE_CODEX_RAW_STREAM_CAPTURE = path;
    const first = Buffer.from('{"type":"response.created"}\n', "utf8");
    const second = Uint8Array.from([0, 1, 2, 127, 128, 255]).buffer;
    const context = {
      connectionId: "connection-1",
      streamId: "stream-1",
      sessionId: "session-1",
      requestId: "request-1",
      subagentLabel: "general-purpose",
      direction: "inbound" as const,
    };

    recordCodexRawFrame(first, { ...context, isBinary: false });
    recordCodexRawFrame(second, { ...context, isBinary: true });

    const records = parseCapture(readFileSync(path));
    expect(records).toHaveLength(2);
    expect(records[0]?.header).toMatchObject({
      version: 1,
      sequence: 1,
      ...context,
      isBinary: false,
      byteLength: first.length,
    });
    expect(records[0]?.payload).toEqual(first);
    expect(records[1]?.header).toMatchObject({
      version: 1,
      sequence: 2,
      ...context,
      isBinary: true,
      byteLength: second.byteLength,
    });
    expect(records[1]?.payload).toEqual(Buffer.from(second));
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("records socket and stream lifecycle with lineage", () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "capture.raw");
    const lifecyclePath = `${path}.lifecycle.jsonl`;
    process.env.OTHERSIDE_CODEX_RAW_STREAM_CAPTURE = path;
    const socket = {
      connectionId: "connection-7",
      sessionId: "session-7",
      agentId: "agent-7",
      agentOwnerId: "agent-parent",
      parentThreadId: "thread-parent",
      subagentLabel: "general-purpose",
      socketKey: "session-7::general-purpose::1",
    };

    recordCodexRawLifecycle("socket_open", socket);
    recordCodexRawLifecycle("stream_start", {
      ...socket,
      streamId: "stream-9",
      requestId: "request-9",
      turnId: "turn-9",
    });
    recordCodexRawLifecycle("stream_end", {
      ...socket,
      streamId: "stream-9",
      reason: "complete",
    });
    recordCodexRawLifecycle("socket_close", { ...socket, code: 1000, reason: "done" });

    const records = readFileSync(lifecyclePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.event)).toEqual([
      "socket_open",
      "stream_start",
      "stream_end",
      "socket_close",
    ]);
    expect(records[1]).toMatchObject({
      version: 1,
      connectionId: "connection-7",
      streamId: "stream-9",
      requestId: "request-9",
      turnId: "turn-9",
      agentId: "agent-7",
      agentOwnerId: "agent-parent",
      parentThreadId: "thread-parent",
    });
    expect(records[0].sequence).toBeLessThan(records[1].sequence);
    expect(records[1].sequence).toBeLessThan(records[2].sequence);
    expect(records[2].sequence).toBeLessThan(records[3].sequence);
    if (process.platform !== "win32") expect(statSync(lifecyclePath).mode & 0o777).toBe(0o600);
  });

  it("routes concurrent replay streams by main and Agent identity", () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "replay.raw");
    const frame = (value: string): Buffer => Buffer.from(value, "utf8");
    writeReplayTape(path, [
      {
        direction: "outbound",
        isBinary: false,
        payload: frame("main-1"),
        connectionId: "connection-main",
        streamId: "captured-main-1",
      },
      { direction: "inbound", isBinary: false, payload: frame("main-1-result") },
      {
        direction: "outbound",
        isBinary: false,
        payload: frame("agent-a-1"),
        connectionId: "connection-a-1",
        streamId: "captured-agent-a-1",
        agentId: "captured-agent-a",
      },
      { direction: "inbound", isBinary: false, payload: frame("agent-a-1-result") },
      {
        direction: "outbound",
        isBinary: false,
        payload: frame("main-2-prewarm"),
        connectionId: "connection-main",
        streamId: "captured-main-2",
      },
      {
        direction: "outbound",
        isBinary: false,
        payload: frame("main-2"),
        connectionId: "connection-main",
        streamId: "captured-main-2",
      },
      { direction: "inbound", isBinary: false, payload: frame("main-2-result") },
      {
        direction: "outbound",
        isBinary: false,
        payload: frame("agent-a-2"),
        connectionId: "connection-a-2",
        streamId: "captured-agent-a-2",
        agentId: "captured-agent-a",
      },
      { direction: "inbound", isBinary: false, payload: frame("agent-a-2-result") },
      {
        direction: "outbound",
        isBinary: false,
        payload: frame("agent-b-1"),
        connectionId: "connection-b-1",
        streamId: "captured-agent-b-1",
        agentId: "captured-agent-b",
      },
      { direction: "inbound", isBinary: false, payload: frame("agent-b-1-result") },
    ]);
    process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY = path;

    const context = (streamId: string, agentId?: string) => ({
      sessionId: "live-session",
      streamId,
      ...(agentId ? { agentId } : {}),
    });
    const next = (streamId: string, agentId?: string) =>
      nextCodexRawOutboundFrame(context(streamId, agentId));

    expect(codexRawReplayStreamNeedsPrewarm(context("live-main-1"))).toBe(false);
    expect(next("live-main-1")).toMatchObject({
      payload: frame("main-1"),
      capturedStreamId: "captured-main-1",
    });
    expect(codexRawReplayStreamNeedsPrewarm(context("live-main-2"))).toBe(true);
    expect(next("live-main-2")).toMatchObject({
      payload: frame("main-2-prewarm"),
      capturedStreamId: "captured-main-2",
    });
    expect(next("live-main-2")).toMatchObject({
      payload: frame("main-2"),
      capturedStreamId: "captured-main-2",
    });
    expect(next("live-agent-a-1", "live-agent-a")).toMatchObject({
      payload: frame("agent-a-1"),
      capturedStreamId: "captured-agent-a-1",
    });
    expect(next("live-agent-b-1", "live-agent-b")).toMatchObject({
      payload: frame("agent-b-1"),
      capturedStreamId: "captured-agent-b-1",
    });
    expect(next("live-agent-a-2", "live-agent-a")).toMatchObject({
      payload: frame("agent-a-2"),
      capturedStreamId: "captured-agent-a-2",
    });
  });

  it("serializes primary socket turns by captured order", async () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "replay.raw");
    const memoryRequest = Buffer.from(
      JSON.stringify({
        instructions:
          "You are selecting memories that will be useful to Otherside CLI as it processes a user's query.",
        input: "first",
      }),
      "utf8",
    );
    writeReplayTape(path, [
      {
        direction: "outbound",
        isBinary: false,
        payload: memoryRequest,
        streamId: "captured-memory-1",
      },
      {
        direction: "outbound",
        isBinary: false,
        payload: Buffer.from("main-1"),
        streamId: "captured-main-1",
      },
    ]);
    process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY = path;

    const order: string[] = [];
    const main = waitForCodexRawPrimaryReplayTurn({
      sessionId: "live-session",
      streamId: "live-main-1",
    }).then(() => {
      order.push("main");
      releaseCodexRawPrimaryReplayTurn({
        sessionId: "live-session",
        streamId: "live-main-1",
      });
    });
    await Bun.sleep(5);
    const memory = waitForCodexRawPrimaryReplayTurn({
      sessionId: "live-session",
      streamId: "live-memory-1",
      requestRole: "memory_recall",
    }).then(() => {
      order.push("memory");
      releaseCodexRawPrimaryReplayTurn({
        sessionId: "live-session",
        streamId: "live-memory-1",
        requestRole: "memory_recall",
      });
    });

    await Promise.all([main, memory]);
    expect(order).toEqual(["memory", "main"]);
  });

  it("routes memory recall independently from main stream order", () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "replay.raw");
    const memoryRequest = (query: string): Buffer =>
      Buffer.from(
        JSON.stringify({
          instructions:
            "You are selecting memories that will be useful to Otherside CLI as it processes a user's query.",
          input: query,
        }),
        "utf8",
      );
    writeReplayTape(path, [
      {
        direction: "outbound",
        isBinary: false,
        payload: memoryRequest("first"),
        streamId: "captured-memory-1",
      },
      {
        direction: "outbound",
        isBinary: false,
        payload: Buffer.from("main-1"),
        streamId: "captured-main-1",
      },
      {
        direction: "outbound",
        isBinary: false,
        payload: Buffer.from("main-2"),
        streamId: "captured-main-2",
      },
      {
        direction: "outbound",
        isBinary: false,
        payload: memoryRequest("second"),
        streamId: "captured-memory-2",
      },
    ]);
    process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY = path;

    const recall = (streamId: string) =>
      nextCodexRawOutboundFrame({
        sessionId: "live-session",
        streamId,
        requestRole: "memory_recall",
      });
    const main = (streamId: string) =>
      nextCodexRawOutboundFrame({ sessionId: "live-session", streamId });

    expect(recall("live-memory-1")).toMatchObject({
      payload: memoryRequest("first"),
      capturedStreamId: "captured-memory-1",
    });
    expect(main("live-main-1")).toMatchObject({
      payload: Buffer.from("main-1"),
      capturedStreamId: "captured-main-1",
    });
    expect(recall("live-memory-2")).toMatchObject({
      payload: memoryRequest("second"),
      capturedStreamId: "captured-memory-2",
    });
    expect(main("live-main-2")).toMatchObject({
      payload: Buffer.from("main-2"),
      capturedStreamId: "captured-main-2",
    });
  });

  it("detects and routes captured title requests independently", () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "replay.raw");
    const titleRequest = Buffer.from(
      JSON.stringify({
        instructions: "Generate a concise, sentence-case title (3-7 words) for this session.",
      }),
      "utf8",
    );
    writeReplayTape(path, [
      {
        direction: "outbound",
        isBinary: false,
        payload: titleRequest,
        streamId: "captured-title-1",
      },
      {
        direction: "outbound",
        isBinary: false,
        payload: Buffer.from("main-1"),
        streamId: "captured-main-1",
      },
    ]);
    process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY = path;

    expect(codexRawReplayHasRequestRole("title")).toBe(true);
    expect(
      nextCodexRawOutboundFrame({
        sessionId: "live-session",
        streamId: "live-title-1",
        requestRole: "title",
      }),
    ).toMatchObject({ payload: titleRequest, capturedStreamId: "captured-title-1" });
    expect(
      nextCodexRawOutboundFrame({ sessionId: "live-session", streamId: "live-main-1" }),
    ).toMatchObject({ payload: Buffer.from("main-1"), capturedStreamId: "captured-main-1" });
  });

  it("reports an absent captured title role", () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "replay.raw");
    writeReplayTape(path, [
      {
        direction: "outbound",
        isBinary: false,
        payload: Buffer.from("main-1"),
        streamId: "captured-main-1",
      },
    ]);
    process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY = path;

    expect(codexRawReplayHasRequestRole("title")).toBe(false);
  });

  it("returns captured outbound frames in global tape order", () => {
    const root = mkdtempSync(join(process.cwd(), ".raw-stream-test-"));
    roots.push(root);
    const path = join(root, "replay.raw");
    const inbound = Buffer.from('{"type":"response.created"}', "utf8");
    const outboundText = Buffer.from('{"type":"response.create","input":[]}', "utf8");
    const outboundBinary = Buffer.from([0, 1, 127, 128, 255]);
    writeReplayTape(path, [
      { direction: "inbound", isBinary: false, payload: inbound },
      { direction: "outbound", isBinary: false, payload: outboundText },
      { direction: "outbound", isBinary: true, payload: outboundBinary },
    ]);
    process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY = path;

    expect(nextCodexRawOutboundFrame()).toEqual({ payload: outboundText, isBinary: false });
    expect(nextCodexRawOutboundFrame()).toEqual({ payload: outboundBinary, isBinary: true });
    expect(() => nextCodexRawOutboundFrame()).toThrow(
      "Codex raw stream replay tape ended before outbound frame",
    );
  });
});

function parseCapture(file: Buffer): ParsedRecord[] {
  expect(file.subarray(0, 8).toString("ascii")).toBe("OSCRAW01");
  const records: ParsedRecord[] = [];
  let offset = 8;
  while (offset < file.length) {
    const headerLength = file.readUInt32BE(offset);
    offset += 4;
    const header = JSON.parse(file.subarray(offset, offset + headerLength).toString("utf8"));
    offset += headerLength;
    const payloadLength = Number(file.readBigUInt64BE(offset));
    offset += 8;
    const payload = file.subarray(offset, offset + payloadLength);
    offset += payloadLength;
    records.push({ header, payload });
  }
  return records;
}

function writeReplayTape(
  path: string,
  records: Array<{
    direction: "inbound" | "outbound";
    isBinary: boolean;
    payload: Buffer;
    connectionId?: string;
    streamId?: string;
    agentId?: string;
  }>,
): void {
  const chunks: Buffer[] = [Buffer.from("OSCRAW01", "ascii")];
  for (const [index, record] of records.entries()) {
    const metadata = Buffer.from(
      JSON.stringify({
        version: 1,
        sequence: index + 1,
        direction: record.direction,
        isBinary: record.isBinary,
        ...(record.connectionId ? { connectionId: record.connectionId } : {}),
        ...(record.streamId ? { streamId: record.streamId } : {}),
        ...(record.agentId ? { agentId: record.agentId } : {}),
        byteLength: record.payload.length,
      }),
      "utf8",
    );
    const metadataLength = Buffer.allocUnsafe(4);
    metadataLength.writeUInt32BE(metadata.length);
    const payloadLength = Buffer.allocUnsafe(8);
    payloadLength.writeBigUInt64BE(BigInt(record.payload.length));
    chunks.push(metadataLength, metadata, payloadLength, record.payload);
  }
  writeFileSync(path, Buffer.concat(chunks));
}
