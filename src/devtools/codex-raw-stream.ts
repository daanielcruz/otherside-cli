import { closeSync, openSync, readSync, statSync } from "node:fs";
import { devtoolPath } from "@/devtools/settings.ts";
import { type CodexRawRequestRole, MAGIC } from "./codex-raw-capture.ts";

export {
  type CodexRawFrameContext,
  type CodexRawLifecycleContext,
  type CodexRawLifecycleEvent,
  type CodexRawRequestRole,
  nextCodexRawConnectionId,
  nextCodexRawStreamId,
  recordCodexRawFrame,
  recordCodexRawLifecycle,
  recordCodexRawReplayDiagnostic,
} from "./codex-raw-capture.ts";

let replayPath: string | undefined;
let replayFd: number | undefined;
let replayFrames: ReplayFrameIndex[] = [];
let replayPrimaryStreams: ReplayStreamIndex[] = [];
let replayMainStreams: ReplayStreamIndex[] = [];
let replayMemoryRecallStreams: ReplayStreamIndex[] = [];
let replayTitleStreams: ReplayStreamIndex[] = [];
let replayAgentGroups: ReplayAgentGroup[] = [];
let replayPrimaryCursor = 0;
let replayPrimaryActiveStreamId: string | undefined;
const replayPrimaryWaiters = new Set<() => void>();
let replayMainCursor = 0;
let replayMemoryRecallCursor = 0;
let replayTitleCursor = 0;
let replayAgentGroupCursor = 0;
let replayFallbackCursor = 0;
const replayLiveStreams = new Map<string, ReplayStreamIndex>();
const replayAgentMappings = new Map<string, ReplayAgentGroup>();

export interface CodexRawReplayContext {
  sessionId: string;
  streamId: string;
  agentId?: string;
  requestRole?: CodexRawRequestRole;
}

export interface CodexRawReplayFrame {
  payload: Buffer;
  isBinary: boolean;
  capturedConnectionId?: string;
  capturedStreamId?: string;
}

export function nextCodexRawOutboundFrame(
  context?: CodexRawReplayContext,
): CodexRawReplayFrame | undefined {
  const path = devtoolPath("codexRawStreamReplay");
  if (!path) {
    closeReplayReader();
    return undefined;
  }
  ensureReplayReader(path);
  const frame = context ? nextContextReplayFrame(path, context) : nextGlobalReplayFrame(path);
  return {
    payload: readReplayPayload(path, frame),
    isBinary: frame.isBinary,
    ...(frame.connectionId ? { capturedConnectionId: frame.connectionId } : {}),
    ...(frame.streamId ? { capturedStreamId: frame.streamId } : {}),
  };
}

export function codexRawReplayStreamNeedsPrewarm(
  context: CodexRawReplayContext,
): boolean | undefined {
  const path = devtoolPath("codexRawStreamReplay");
  if (!path) {
    closeReplayReader();
    return undefined;
  }
  ensureReplayReader(path);
  return replayStreamForContext(path, context).outbound.length > 1;
}

export function codexRawReplayHasRequestRole(role: CodexRawRequestRole): boolean | undefined {
  const path = devtoolPath("codexRawStreamReplay");
  if (!path) {
    closeReplayReader();
    return undefined;
  }
  ensureReplayReader(path);
  return role === "memory_recall"
    ? replayMemoryRecallStreams.length > 0
    : replayTitleStreams.length > 0;
}

export async function waitForCodexRawPrimaryReplayTurn(
  context: CodexRawReplayContext,
): Promise<void> {
  if (context.agentId) return;
  const path = devtoolPath("codexRawStreamReplay");
  if (!path) {
    closeReplayReader();
    return;
  }
  ensureReplayReader(path);
  const stream = replayStreamForContext(path, context);
  await waitForPrimaryStreamTurn(path, stream, context.streamId);
}

export function releaseCodexRawPrimaryReplayTurn(context: CodexRawReplayContext): void {
  if (context.agentId) return;
  const path = devtoolPath("codexRawStreamReplay");
  if (!path || replayFd === undefined || replayPath !== path) return;
  if (replayPrimaryActiveStreamId !== context.streamId) return;
  replayPrimaryActiveStreamId = undefined;
  replayPrimaryCursor += 1;
  wakePrimaryWaiters();
}

interface ReplayFrameIndex {
  sequence: number;
  direction: "inbound" | "outbound";
  isBinary: boolean;
  connectionId?: string;
  streamId?: string;
  agentId?: string;
  requestRole?: CodexRawRequestRole;
  payloadOffset: number;
  payloadLength: number;
}

interface ReplayStreamIndex {
  id: string;
  agentId?: string;
  requestRole?: CodexRawRequestRole;
  outbound: ReplayFrameIndex[];
  cursor: number;
}

interface ReplayAgentGroup {
  id: string;
  streams: ReplayStreamIndex[];
  cursor: number;
}

function ensureReplayReader(path: string): void {
  if (replayFd !== undefined && replayPath === path) return;
  closeReplayReader();
  const fd = openSync(path, "r");
  try {
    const magic = Buffer.allocUnsafe(MAGIC.length);
    readAt(fd, magic, 0, path, "header");
    if (!magic.equals(MAGIC)) throw new Error(`invalid Codex raw stream replay tape: ${path}`);
    const indexed = indexReplayTape(fd, path);
    replayFrames = indexed.frames;
    replayPrimaryStreams = indexed.primaryStreams;
    replayMainStreams = indexed.mainStreams;
    replayMemoryRecallStreams = indexed.memoryRecallStreams;
    replayTitleStreams = indexed.titleStreams;
    replayAgentGroups = indexed.agentGroups;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  replayPath = path;
  replayFd = fd;
}

function indexReplayTape(
  fd: number,
  path: string,
): {
  frames: ReplayFrameIndex[];
  primaryStreams: ReplayStreamIndex[];
  mainStreams: ReplayStreamIndex[];
  memoryRecallStreams: ReplayStreamIndex[];
  titleStreams: ReplayStreamIndex[];
  agentGroups: ReplayAgentGroup[];
} {
  const frames: ReplayFrameIndex[] = [];
  const streams = new Map<string, ReplayStreamIndex>();
  const streamOrder: ReplayStreamIndex[] = [];
  let offset = MAGIC.length;
  const size = statSync(path).size;
  while (offset < size) {
    const metadataLengthBytes = Buffer.allocUnsafe(4);
    readAt(fd, metadataLengthBytes, offset, path, "metadata length");
    const metadataLength = metadataLengthBytes.readUInt32BE(0);
    offset += metadataLengthBytes.length;
    const metadataBytes = Buffer.allocUnsafe(metadataLength);
    readAt(fd, metadataBytes, offset, path, "metadata");
    offset += metadataLength;
    const payloadLengthBytes = Buffer.allocUnsafe(8);
    readAt(fd, payloadLengthBytes, offset, path, "payload length");
    const payloadLengthBigInt = payloadLengthBytes.readBigUInt64BE(0);
    if (payloadLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Codex raw stream replay payload is too large: ${path}`);
    }
    const payloadLength = Number(payloadLengthBigInt);
    offset += payloadLengthBytes.length;
    if (offset + payloadLength > size) {
      throw new Error(`Codex raw stream replay tape ended while reading payload: ${path}`);
    }
    const metadata = parseReplayMetadata(metadataBytes, payloadLength, path);
    const requestRole =
      metadata.requestRole ??
      (metadata.direction === "outbound" && !metadata.agentId
        ? inferReplayRequestRole(fd, offset, payloadLength, path)
        : undefined);
    const frame: ReplayFrameIndex = {
      sequence: metadata.sequence,
      direction: metadata.direction,
      isBinary: metadata.isBinary,
      ...(metadata.connectionId ? { connectionId: metadata.connectionId } : {}),
      ...(metadata.streamId ? { streamId: metadata.streamId } : {}),
      ...(metadata.agentId ? { agentId: metadata.agentId } : {}),
      ...(requestRole ? { requestRole } : {}),
      payloadOffset: offset,
      payloadLength,
    };
    frames.push(frame);
    if (frame.direction === "outbound" && frame.streamId) {
      let stream = streams.get(frame.streamId);
      if (!stream) {
        stream = {
          id: frame.streamId,
          ...(frame.agentId ? { agentId: frame.agentId } : {}),
          ...(frame.requestRole ? { requestRole: frame.requestRole } : {}),
          outbound: [],
          cursor: 0,
        };
        streams.set(stream.id, stream);
        streamOrder.push(stream);
      }
      if (frame.requestRole) stream.requestRole = frame.requestRole;
      stream.outbound.push(frame);
    }
    offset += payloadLength;
  }

  const primaryStreams = streamOrder.filter((stream) => !stream.agentId);
  const mainStreams = streamOrder.filter((stream) => !stream.agentId && !stream.requestRole);
  const memoryRecallStreams = streamOrder.filter(
    (stream) => stream.requestRole === "memory_recall",
  );
  const titleStreams = streamOrder.filter((stream) => stream.requestRole === "title");
  const groups = new Map<string, ReplayAgentGroup>();
  for (const stream of streamOrder) {
    if (!stream.agentId) continue;
    let group = groups.get(stream.agentId);
    if (!group) {
      group = { id: stream.agentId, streams: [], cursor: 0 };
      groups.set(group.id, group);
    }
    group.streams.push(stream);
  }
  return {
    frames,
    primaryStreams,
    mainStreams,
    memoryRecallStreams,
    titleStreams,
    agentGroups: [...groups.values()],
  };
}

function parseReplayMetadata(
  bytes: Buffer,
  payloadLength: number,
  path: string,
): {
  sequence: number;
  direction: "inbound" | "outbound";
  isBinary: boolean;
  connectionId?: string;
  streamId?: string;
  agentId?: string;
  requestRole?: CodexRawRequestRole;
} {
  let metadata: unknown;
  try {
    metadata = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`invalid Codex raw stream replay metadata: ${path}`);
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("sequence" in metadata) ||
    typeof metadata.sequence !== "number" ||
    !("direction" in metadata) ||
    (metadata.direction !== "inbound" && metadata.direction !== "outbound") ||
    !("isBinary" in metadata) ||
    typeof metadata.isBinary !== "boolean" ||
    !("byteLength" in metadata) ||
    metadata.byteLength !== payloadLength ||
    ("connectionId" in metadata &&
      metadata.connectionId !== undefined &&
      typeof metadata.connectionId !== "string") ||
    ("streamId" in metadata &&
      metadata.streamId !== undefined &&
      typeof metadata.streamId !== "string") ||
    ("agentId" in metadata &&
      metadata.agentId !== undefined &&
      typeof metadata.agentId !== "string") ||
    ("requestRole" in metadata &&
      metadata.requestRole !== undefined &&
      metadata.requestRole !== "memory_recall" &&
      metadata.requestRole !== "title")
  ) {
    throw new Error(`invalid Codex raw stream replay metadata fields: ${path}`);
  }
  const parsed = metadata as {
    sequence: number;
    direction: "inbound" | "outbound";
    isBinary: boolean;
    connectionId?: string;
    streamId?: string;
    agentId?: string;
    requestRole?: CodexRawRequestRole;
  };
  return {
    sequence: parsed.sequence,
    direction: parsed.direction,
    isBinary: parsed.isBinary,
    ...(parsed.connectionId ? { connectionId: parsed.connectionId } : {}),
    ...(parsed.streamId ? { streamId: parsed.streamId } : {}),
    ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
    ...(parsed.requestRole ? { requestRole: parsed.requestRole } : {}),
  };
}

function inferReplayRequestRole(
  fd: number,
  payloadOffset: number,
  payloadLength: number,
  path: string,
): CodexRawRequestRole | undefined {
  const markers: [CodexRawRequestRole, Buffer][] = [
    [
      "memory_recall",
      Buffer.from(
        "You are selecting memories that will be useful to Otherside CLI as it processes a user's query.",
        "utf8",
      ),
    ],
    ["title", Buffer.from("Generate a concise, sentence-case title (3-7 words)", "utf8")],
  ];
  if (markers.every(([, marker]) => payloadLength < marker.length)) return undefined;
  const payload = Buffer.allocUnsafe(payloadLength);
  readAt(fd, payload, payloadOffset, path, "request role");
  return markers.find(([, marker]) => payload.includes(marker))?.[0];
}

function nextContextReplayFrame(path: string, context: CodexRawReplayContext): ReplayFrameIndex {
  const stream = replayStreamForContext(path, context);
  const frame = stream.outbound[stream.cursor];
  if (!frame) {
    throw new Error(`Codex raw stream replay exhausted captured stream ${stream.id}: ${path}`);
  }
  stream.cursor += 1;
  return frame;
}

function replayStreamForContext(path: string, context: CodexRawReplayContext): ReplayStreamIndex {
  let stream = replayLiveStreams.get(context.streamId);
  if (!stream) {
    stream = context.agentId
      ? nextAgentReplayStream(path, context.agentId)
      : context.requestRole === "memory_recall"
        ? nextMemoryRecallReplayStream(path)
        : context.requestRole === "title"
          ? nextTitleReplayStream(path)
          : nextMainReplayStream(path);
    replayLiveStreams.set(context.streamId, stream);
  }
  return stream;
}

function nextMainReplayStream(path: string): ReplayStreamIndex {
  const stream = replayMainStreams[replayMainCursor];
  if (!stream) throw new Error(`Codex raw stream replay exhausted main streams: ${path}`);
  replayMainCursor += 1;
  return stream;
}

function nextMemoryRecallReplayStream(path: string): ReplayStreamIndex {
  const stream = replayMemoryRecallStreams[replayMemoryRecallCursor];
  if (!stream) throw new Error(`Codex raw stream replay exhausted memory recall streams: ${path}`);
  replayMemoryRecallCursor += 1;
  return stream;
}

function nextTitleReplayStream(path: string): ReplayStreamIndex {
  const stream = replayTitleStreams[replayTitleCursor];
  if (!stream) throw new Error(`Codex raw stream replay exhausted title streams: ${path}`);
  replayTitleCursor += 1;
  return stream;
}

async function waitForPrimaryStreamTurn(
  path: string,
  stream: ReplayStreamIndex,
  liveStreamId: string,
): Promise<void> {
  while (true) {
    const expected = replayPrimaryStreams[replayPrimaryCursor];
    if (!expected) {
      throw new Error(`Codex raw stream replay exhausted primary streams: ${path}`);
    }
    if (expected.id === stream.id) {
      if (
        replayPrimaryActiveStreamId !== undefined &&
        replayPrimaryActiveStreamId !== liveStreamId
      ) {
        await waitPrimaryWake();
        continue;
      }
      replayPrimaryActiveStreamId = liveStreamId;
      return;
    }
    await waitPrimaryWake();
  }
}

function waitPrimaryWake(): Promise<void> {
  return new Promise((resolve) => {
    replayPrimaryWaiters.add(resolve);
  });
}

function wakePrimaryWaiters(): void {
  const waiters = [...replayPrimaryWaiters];
  replayPrimaryWaiters.clear();
  for (const wake of waiters) wake();
}

function nextAgentReplayStream(path: string, liveAgentId: string): ReplayStreamIndex {
  let group = replayAgentMappings.get(liveAgentId);
  if (!group) {
    group = replayAgentGroups[replayAgentGroupCursor];
    if (!group) throw new Error(`Codex raw stream replay exhausted Agent groups: ${path}`);
    replayAgentGroupCursor += 1;
    replayAgentMappings.set(liveAgentId, group);
  }
  const stream = group.streams[group.cursor];
  if (!stream) throw new Error(`Codex raw stream replay exhausted Agent ${group.id}: ${path}`);
  group.cursor += 1;
  return stream;
}

function nextGlobalReplayFrame(path: string): ReplayFrameIndex {
  while (true) {
    const frame = replayFrames[replayFallbackCursor];
    if (!frame)
      throw new Error(`Codex raw stream replay tape ended before outbound frame: ${path}`);
    replayFallbackCursor += 1;
    if (frame.direction === "outbound") return frame;
  }
}

function readReplayPayload(path: string, frame: ReplayFrameIndex): Buffer {
  const fd = replayFd;
  if (fd === undefined) throw new Error(`Codex raw stream replay tape is not open: ${path}`);
  const payload = Buffer.allocUnsafe(frame.payloadLength);
  readAt(fd, payload, frame.payloadOffset, path, "payload");
  return payload;
}

function readAt(fd: number, buffer: Buffer, position: number, path: string, field: string): void {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) {
      throw new Error(`Codex raw stream replay tape ended while reading ${field}: ${path}`);
    }
    offset += bytesRead;
  }
}

function closeReplayReader(): void {
  if (replayFd !== undefined) closeSync(replayFd);
  replayPath = undefined;
  replayFd = undefined;
  replayFrames = [];
  replayPrimaryStreams = [];
  replayMainStreams = [];
  replayMemoryRecallStreams = [];
  replayTitleStreams = [];
  replayAgentGroups = [];
  replayPrimaryCursor = 0;
  replayPrimaryActiveStreamId = undefined;
  wakePrimaryWaiters();
  replayMainCursor = 0;
  replayMemoryRecallCursor = 0;
  replayTitleCursor = 0;
  replayAgentGroupCursor = 0;
  replayFallbackCursor = 0;
  replayLiveStreams.clear();
  replayAgentMappings.clear();
}
