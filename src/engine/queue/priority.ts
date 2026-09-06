import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

// SoT: the delivery bands ARE the class enumeration; EmitClass and the priority
// order both derive from them. A band is one delivery lane, listed most urgent
// first. Classes inside a band differ in what they carry, never in when they
// land, so a band drains in arrival order rather than in the order its classes
// happen to be written here.
//
// Background notifications ride the middle band. They fold at the next turn
// boundary — after a response or tool batch, never during streaming — and
// trigger the same continuation as queued user input. idle_prompt is the lowest
// band: it drains ONLY at turn_start, so scheduled wakeups never enter a
// running turn.
export const DELIVERY_BANDS = [
  ["interrupt_bash"],
  ["urgent_output", "deferred_output"],
  ["idle_prompt"],
] as const;

export type EmitClass = (typeof DELIVERY_BANDS)[number][number];

export const PRIORITY_ORDER: readonly EmitClass[] = DELIVERY_BANDS.flat();

export type EmitTarget = "transcript" | "llm_request" | "both" | "inventory" | "none";

export type EmitBoundary = "turn_start" | "mid_turn" | "tool_loop_end";

export type EmitPayload =
  | { kind: "tool_result"; toolUseId: string; content: string | ContentBlock[]; isError?: boolean }
  | { kind: "tool_result_interrupt"; toolUseId: string; content: string }
  | { kind: "task_notification_xml"; text: string; summary?: string; isError?: boolean }
  | { kind: "fork_event"; event: unknown }
  | { kind: "user_interrupt_message"; text: string };

export interface EmitItemInput {
  class: EmitClass;
  target: EmitTarget;
  payload: EmitPayload;
  autoTurn?: boolean;
  ownerId?: string;
  replayKey?: string;
  sticky?: boolean;
  /** Marks a stop-hook rewake: the turn that consumes this item runs its own
   * Stop hooks with STOP_HOOK_ACTIVE so a hook can break the rewake loop. */
  stopHookActive?: boolean;
}

export interface EmitItem extends EmitItemInput {
  id: string;
  ts: number;
  /** Arrival order. `ts` alone cannot separate two items of the same millisecond. */
  seq: number;
}

export interface BoundaryPolicyEntry {
  readonly class: EmitClass;
  readonly target: EmitTarget;
}

export interface BoundaryPolicy {
  readonly entries: readonly BoundaryPolicyEntry[];
}

export interface DrainResult {
  llmBlocks: ContentBlock[];
  transcriptEntries: TranscriptEntry[];
  consumedIds: readonly string[];
  /** Raw task-notification XML delivered to the LLM in this drain — the
   * consumer persists each as a queued_command attachment record so resume
   * rebuilds the same conversation. */
  notificationTexts: readonly string[];
  /** True when a consumed item was a stop-hook rewake (see EmitItemInput). */
  stopHookActive?: boolean;
}

export interface CancelResult {
  cancelledIds: string[];
  classCounts: Record<EmitClass, number>;
}

export const BOUNDARY_POLICY: Record<EmitBoundary, BoundaryPolicy> = {
  turn_start: {
    entries: [
      { class: "interrupt_bash", target: "both" },
      { class: "urgent_output", target: "both" },
      { class: "deferred_output", target: "both" },
      // idle_prompt (scheduled wakeups) drains here and ONLY here.
      { class: "idle_prompt", target: "both" },
    ],
  },
  mid_turn: {
    entries: [
      { class: "interrupt_bash", target: "llm_request" },
      { class: "urgent_output", target: "llm_request" },
      { class: "deferred_output", target: "llm_request" },
    ],
  },
  // deferred_output drains here too: background completions land between
  // tool batches of the ongoing turn (next inference step), not at idle.
  tool_loop_end: {
    entries: [
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
