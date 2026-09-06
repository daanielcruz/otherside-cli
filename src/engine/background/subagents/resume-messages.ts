import { appendAgentRecordRaw } from "@/engine/session/append.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import { sanitizeMessages } from "@/engine/translator/sanitize.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { ForkResumeProfile } from "./durable-profile.ts";
import { pendingAgentSteers, takeAgentSteers } from "./fork/steering.ts";

export function snapshotMessages(messages: Message[] | undefined): Message[] | undefined {
  return messages?.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
  }));
}

export function mergeResumedMessages(args: {
  baseMessages?: Message[];
  history: Message[];
  steers: Message[];
  prompt: string;
}): Message[] {
  const promptMessage: Message = {
    role: "user",
    content: [{ type: "text", text: args.prompt }],
  };
  if (args.baseMessages === undefined) {
    return sanitizeMessages([...args.history, ...args.steers, promptMessage]);
  }

  const durableIds = new Set(
    args.history.flatMap((message) => (message.id === undefined ? [] : [message.id])),
  );
  const baseMessages = (snapshotMessages(args.baseMessages) ?? []).filter(
    (message) => message.id === undefined || !durableIds.has(message.id),
  );
  const transcriptAfterInitialPrompt =
    args.history[0]?.role === "user" ? args.history.slice(1) : args.history;
  return sanitizeMessages([
    ...baseMessages,
    ...transcriptAfterInitialPrompt,
    ...args.steers,
    promptMessage,
  ]);
}

export interface UndrainedSteer {
  message: Message;
  text: string;
  queueId?: string;
}

/** Ids of the steers already waiting, which is what a resume accepted at this moment. */
export function queuedSteerIds(forkId: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const queued of pendingAgentSteers(forkId)) {
    if (queued.queueId !== undefined) ids.add(queued.queueId);
  }
  return ids;
}

export function drainUndrainedSteers(forkId: string, ids: ReadonlySet<string>): UndrainedSteer[] {
  const steers: UndrainedSteer[] = [];
  for (const queued of takeAgentSteers(forkId, ids)) {
    steers.push({
      message: {
        role: "user",
        content: queued.blocks,
        ...(queued.queueId !== undefined ? { id: queued.queueId } : {}),
      },
      text: queued.text,
      ...(queued.queueId !== undefined ? { queueId: queued.queueId } : {}),
    });
  }
  return steers;
}

// Persist each undrained steer as a user record in the sidechain transcript, in
// queue order, immediately before the resume prompt record (which the fork loop
// writes when the resumed run starts). Without this, only the prompt is
// persisted, so a second resume rebuilds history missing these steers and the
// agent's replies reference a message that is no longer there.
export async function persistResumeSteerRecords(
  profile: ForkResumeProfile,
  steers: UndrainedSteer[],
): Promise<void> {
  for (const steer of steers) {
    await appendAgentRecordRaw(
      {
        cwd: profile.ctx.originalCwd ?? profile.ctx.cwd,
        sessionId: profile.ctx.sessionId,
        agentId: profile.forkId,
      },
      {
        type: "user_message",
        ts: nowIso(),
        content: steer.text,
        provider: profile.ctx.provider,
        model: profile.ctx.model,
        isSidechain: true,
        ...(steer.queueId !== undefined ? { queueId: steer.queueId } : {}),
        ...(profile.spec.parentToolCallId !== undefined
          ? { parentToolCallId: profile.spec.parentToolCallId }
          : {}),
        ...(profile.spec.agentId !== undefined ? { agentId: profile.spec.agentId } : {}),
      },
    );
  }
}
