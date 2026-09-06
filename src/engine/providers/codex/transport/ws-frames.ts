import { createHash } from "node:crypto";
import type { WebSocket as WsClient } from "ws";
import {
  type CodexRawFrameContext,
  nextCodexRawOutboundFrame,
  recordCodexRawFrame,
  recordCodexRawReplayDiagnostic,
} from "@/devtools/codex-raw-stream.ts";
import type { CodexRequestMetadata } from "@/engine/providers/codex/metadata.ts";

/**
 * Outbound frame path: request-frame construction, send-buffer drain guard,
 * and raw-capture/replay substitution on every send.
 */

const CODEX_WS_SEND_BUFFERED_AMOUNT_LIMIT_BYTES = 4 * 1024 * 1024;
const CODEX_WS_SEND_DRAIN_TIMEOUT_MS = 5_000;
const CODEX_WS_SEND_DRAIN_POLL_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWsSendDrain(ws: WsClient): Promise<void> {
  const startedAt = Date.now();
  while (ws.bufferedAmount > CODEX_WS_SEND_BUFFERED_AMOUNT_LIMIT_BYTES) {
    if (ws.readyState !== ws.OPEN) {
      throw new Error("codex ws send buffer could not drain because the socket closed");
    }
    if (Date.now() - startedAt >= CODEX_WS_SEND_DRAIN_TIMEOUT_MS) {
      throw new Error(
        `codex ws send buffer remained above ${CODEX_WS_SEND_BUFFERED_AMOUNT_LIMIT_BYTES} bytes for ${CODEX_WS_SEND_DRAIN_TIMEOUT_MS}ms`,
      );
    }
    await delay(CODEX_WS_SEND_DRAIN_POLL_MS);
  }
}

function pendingWsSendDrain(ws: WsClient): Promise<void> | null {
  if (ws.bufferedAmount <= CODEX_WS_SEND_BUFFERED_AMOUNT_LIMIT_BYTES) return null;
  return waitForWsSendDrain(ws);
}

export function sendWsJsonFrame(
  ws: WsClient,
  frame: Record<string, unknown>,
  captureContext: Omit<CodexRawFrameContext, "isBinary">,
): Promise<void> | null {
  const generatedPayload = JSON.stringify(frame);
  const replayFrame = nextCodexRawOutboundFrame({
    sessionId: captureContext.sessionId,
    streamId: captureContext.streamId,
    ...(captureContext.agentId ? { agentId: captureContext.agentId } : {}),
    ...(captureContext.requestRole ? { requestRole: captureContext.requestRole } : {}),
  });
  if (replayFrame) {
    const generatedBytes = Buffer.from(generatedPayload, "utf8");
    recordCodexRawReplayDiagnostic({
      event: "outbound_substitution",
      liveStreamId: captureContext.streamId,
      capturedStreamId: replayFrame.capturedStreamId,
      ...(captureContext.agentId ? { agentId: captureContext.agentId } : {}),
      generatedBytes: generatedBytes.length,
      replayBytes: replayFrame.payload.length,
      generatedSha256: createHash("sha256").update(generatedBytes).digest("hex"),
      replaySha256: createHash("sha256").update(replayFrame.payload).digest("hex"),
      byteEqual: replayFrame.payload.equals(generatedBytes),
    });
  }
  const payload = replayFrame?.payload ?? generatedPayload;
  const isBinary = replayFrame?.isBinary ?? false;
  const send = (): void => {
    recordCodexRawFrame(payload, { ...captureContext, isBinary });
    if (replayFrame) ws.send(replayFrame.payload, { binary: replayFrame.isBinary });
    else ws.send(generatedPayload);
  };
  const drain = pendingWsSendDrain(ws);
  if (!drain) {
    send();
    return null;
  }
  return drain.then(send);
}

export function buildWsFrame(
  body: unknown,
  requestMetadata: CodexRequestMetadata,
): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const frame: Record<string, unknown> = { type: "response.create" };
  if (src.model !== undefined) frame.model = src.model;
  if (src.instructions !== undefined) frame.instructions = src.instructions;
  if (src.input !== undefined) frame.input = src.input;
  if (src.tools !== undefined) frame.tools = src.tools;
  if (src.tool_choice !== undefined) frame.tool_choice = src.tool_choice;
  if (src.parallel_tool_calls !== undefined) frame.parallel_tool_calls = src.parallel_tool_calls;
  frame.reasoning = src.reasoning ?? null;
  if (src.store !== undefined) frame.store = src.store;
  if (src.stream !== undefined) frame.stream = src.stream;
  frame.include = src.include ?? [];
  if (src.service_tier !== undefined) frame.service_tier = src.service_tier;
  if (src.prompt_cache_key !== undefined) frame.prompt_cache_key = src.prompt_cache_key;
  if (src.text !== undefined) frame.text = src.text;
  frame.client_metadata = requestMetadata.clientMetadata;
  return frame;
}
