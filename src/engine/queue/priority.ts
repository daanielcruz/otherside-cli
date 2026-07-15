import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

// SoT: the priority order IS the class enumeration; EmitClass derives from it.
// Background notifications ride one of two lanes named by delivery urgency:
// urgent_output reaches the model at the next LLM call (drained at every
// tool-loop boundary); deferred_output rides tool-loop ends and turn_start —
// completions steer the ongoing turn between tool batches without ever
// cutting into a streaming response.
export const PRIORITY_ORDER = [
  "interrupt_agent_workflow",
  "interrupt_bash",
  "user_message",
  "urgent_output",
  "deferred_output",
] as const;

export type EmitClass = (typeof PRIORITY_ORDER)[number];

export type EmitTarget = "transcript" | "llm_request" | "both" | "inventory" | "none";

export type EmitBoundary = "turn_start" | "mid_turn" | "tool_loop_end";

export type EmitPayload =
  | { kind: "tool_result"; toolUseId: string; content: string | ContentBlock[]; isError?: boolean }
  | { kind: "tool_result_interrupt"; toolUseId: string; content: string }
  | { kind: "task_notification_xml"; text: string; summary?: string; isError?: boolean }
  | { kind: "queued_message"; queuedMessageId: string }
  | { kind: "fork_event"; event: unknown }
  | { kind: "user_interrupt_message"; text: string }
  | { kind: "killed_by_user"; taskId: string; content: string }
  | { kind: "killed_workflow"; taskId: string };

export interface EmitItemInput {
  class: EmitClass;
  target: EmitTarget;
  payload: EmitPayload;
  autoTurn?: boolean;
  ownerId?: string;
  replayKey?: string;
  sticky?: boolean;
}

export interface EmitItem extends EmitItemInput {
  id: string;
  ts: number;
}

export interface BoundaryPolicyEntry {
  readonly class: EmitClass;
  readonly target: EmitTarget;
}

export interface BoundaryPolicy {
  readonly entries: readonly BoundaryPolicyEntry[];
  readonly wrapSystemReminder?: boolean;
}

export interface QueuedPastedImageView {
  id: number;
  mediaType: string;
  localPath?: string;
}

export interface QueuedMessageView {
  id: string;
  expanded: string;
  blocks?: ContentBlock[];
  pastedImages?: readonly QueuedPastedImageView[];
}

export type QueuedMessageLookup = (id: string) => QueuedMessageView | undefined;

export interface DrainResult {
  llmBlocks: ContentBlock[];
  transcriptEntries: TranscriptEntry[];
  consumedIds: readonly string[];
  removedQueuedMessageIds: readonly string[];
  /** Raw task-notification XML delivered to the LLM in this drain — the
   * consumer persists each as a queued_command attachment record so resume
   * rebuilds the same conversation. */
  notificationTexts: readonly string[];
}

export interface CancelResult {
  cancelledIds: string[];
  classCounts: Record<EmitClass, number>;
}

export const BOUNDARY_POLICY: Record<EmitBoundary, BoundaryPolicy> = {
  turn_start: {
    entries: [
      { class: "interrupt_agent_workflow", target: "both" },
      { class: "interrupt_bash", target: "both" },
      { class: "user_message", target: "llm_request" },
      { class: "urgent_output", target: "both" },
      { class: "deferred_output", target: "both" },
    ],
  },
  mid_turn: {
    entries: [
      { class: "interrupt_agent_workflow", target: "llm_request" },
      { class: "interrupt_bash", target: "llm_request" },
      { class: "user_message", target: "llm_request" },
    ],
    wrapSystemReminder: true,
  },
  // deferred_output drains here too: background completions land between
  // tool batches of the ongoing turn (next inference step), not at idle.
  tool_loop_end: {
    entries: [
      { class: "interrupt_agent_workflow", target: "llm_request" },
      { class: "interrupt_bash", target: "llm_request" },
      { class: "urgent_output", target: "llm_request" },
      { class: "deferred_output", target: "llm_request" },
    ],
  },
};

export interface PriorityStateSnapshot {
  readonly sizes: Readonly<Record<EmitClass, number>>;
  readonly hasPendingAutoTurn: boolean;
  readonly turnActive: boolean;
}

export class ProjectionError extends Error {
  constructor(
    message: string,
    readonly item: EmitItem,
  ) {
    super(message);
    this.name = "ProjectionError";
  }
}
