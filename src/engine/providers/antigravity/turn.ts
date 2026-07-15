import { createHash } from "node:crypto";

export interface AntigravityTurnIds {
  conversationId: string;
  trajectoryId: string;
  sessionId: string;
}

function digest(seed: string): Buffer {
  return createHash("sha1").update(seed).digest();
}

function deriveUuid(sessionId: string, salt: string): string {
  const b = Buffer.from(digest(`${sessionId}:${salt}`).subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function deriveSessionInt(sessionId: string): string {
  return digest(`${sessionId}:sessionId`).readBigInt64BE(0).toString();
}

// conversationId and trajectoryId are unique per task, while sessionId remains stable for the installation session. Subagent threads derive their own trajectory pair so parallel agents do not share a server-side trajectory.
export function turnIds(sessionId: string, threadId?: string): AntigravityTurnIds {
  const trajectorySeed = threadId ?? sessionId;
  return {
    conversationId: deriveUuid(trajectorySeed, "conversation"),
    trajectoryId: deriveUuid(trajectorySeed, "trajectory"),
    sessionId: deriveSessionInt(sessionId),
  };
}

export function trajectoryStepCount(request: Record<string, unknown>): number {
  const contents = request.contents;
  if (!Array.isArray(contents)) return 0;
  return contents.filter((c) => isUserStep(c)).length;
}

// Include `last_execution_id` only after a prior role:"model" turn. It identifies the completed model execution; derive a stable local ID from the trajectory seed and execution count because no server-issued ID is available.
function completedExecutionCount(request: Record<string, unknown>): number {
  const contents = request.contents;
  if (!Array.isArray(contents)) return 0;
  return contents.filter(
    (c) => Boolean(c) && typeof c === "object" && (c as { role?: unknown }).role === "model",
  ).length;
}

export function lastExecutionId(
  sessionId: string,
  threadId: string | undefined,
  request: Record<string, unknown>,
): string | undefined {
  const executions = completedExecutionCount(request);
  if (executions < 1) return undefined;
  const seed = threadId ?? sessionId;
  return deriveUuid(seed, `execution:${executions}`);
}

// Tool results ride as role:"user" functionResponse entries on the Gemini wire; the last_step_index parameter counts only real user steps.
function isUserStep(content: unknown): boolean {
  if (!content || typeof content !== "object") return false;
  const entry = content as { role?: unknown; parts?: unknown };
  if (entry.role !== "user") return false;
  if (!Array.isArray(entry.parts) || entry.parts.length === 0) return true;
  return !entry.parts.every(
    (part) => Boolean(part) && typeof part === "object" && "functionResponse" in part,
  );
}
