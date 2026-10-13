import { createHash } from "node:crypto";

export interface AntigravityTurnIds {
  /** The task: the cascade a trajectory belongs to. */
  conversationId: string;
  /** The cascade a subagent was started from; the task's own cascade otherwise. */
  rootConversationId: string;
  trajectoryId: string;
}

// The installed client sends one session id for every request: the 64-bit
// FNV-1a hash of an empty string, as a signed decimal.
export const CODE_ASSIST_SESSION_ID = "-3750763034362895579";

function digest(seed: string): Buffer {
  return createHash("sha1").update(seed).digest();
}

function deriveUuid(seed: string, salt: string): string {
  const b = Buffer.from(digest(`${seed}:${salt}`).subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// conversationId and trajectoryId are unique per task. Subagent threads derive
// their own pair so parallel agents do not share a server-side trajectory, and
// name the session's cascade as their root.
export function turnIds(sessionId: string, threadId?: string): AntigravityTurnIds {
  const trajectorySeed = threadId ?? sessionId;
  return {
    conversationId: deriveUuid(trajectorySeed, "conversation"),
    rootConversationId: deriveUuid(sessionId, "conversation"),
    trajectoryId: deriveUuid(trajectorySeed, "trajectory"),
  };
}

interface WireContent {
  role?: unknown;
  parts?: unknown;
}

function contentsOf(request: Record<string, unknown>): WireContent[] {
  const contents = request.contents;
  if (!Array.isArray(contents)) return [];
  return contents.filter((c): c is WireContent => Boolean(c) && typeof c === "object");
}

function partsOf(content: WireContent): Record<string, unknown>[] {
  if (!Array.isArray(content.parts)) return [];
  return content.parts.filter(
    (p): p is Record<string, unknown> => Boolean(p) && typeof p === "object",
  );
}

function toolResponseCount(content: WireContent): number {
  return partsOf(content).filter((part) => "functionResponse" in part).length;
}

/** A model reply: what the model generated, as opposed to the tool results sent back. */
function isModelReply(content: WireContent): boolean {
  return content.role === "model" && toolResponseCount(content) === 0;
}

/**
 * The trajectory's steps so far: every user input, every model reply, and every
 * tool result is one step. The request names the index of the last one.
 */
export function lastStepIndex(request: Record<string, unknown>): number {
  let steps = 0;
  for (const content of contentsOf(request)) {
    const results = toolResponseCount(content);
    steps += results > 0 ? results : 1;
  }
  return Math.max(0, steps - 1);
}

/** How many times the model has already been asked in this trajectory. */
export function priorModelReplies(request: Record<string, unknown>): number {
  return contentsOf(request).filter(isModelReply).length;
}

/**
 * An execution is one user input answered to the end. The id of the last one
 * appears once a later input opens a new execution; derived locally and stably
 * because no server-issued id is available.
 */
export function lastExecutionId(
  sessionId: string,
  threadId: string | undefined,
  request: Record<string, unknown>,
): string | undefined {
  let sawReply = false;
  let completed = 0;
  for (const content of contentsOf(request)) {
    if (isModelReply(content)) sawReply = true;
    else if (content.role === "user" && toolResponseCount(content) === 0 && sawReply) {
      completed += 1;
      sawReply = false;
    }
  }
  if (completed < 1) return undefined;
  return deriveUuid(threadId ?? sessionId, `execution:${completed}`);
}
