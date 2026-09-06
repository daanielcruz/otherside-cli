export interface PromptSnapshot {
  readonly text: string;
  readonly caret: number;
}

export interface PromptUndoOptions {
  readonly maxSteps?: number;
  readonly coalesceMs?: number;
  readonly now?: () => number;
}

const MAX_STEPS = 50;
const COALESCE_MS = 1_000;

/**
 * Undo history for the prompt buffer. A snapshot taken within `coalesceMs` of the
 * previous one folds into it, so a typing burst rewinds as a single step while a
 * pause opens the next one. The oldest step is dropped once the cap is reached.
 */
export class PromptUndoHistory {
  private readonly steps: PromptSnapshot[] = [];
  private readonly maxSteps: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private lastRecordedAt: number | null = null;

  constructor(options: PromptUndoOptions = {}) {
    this.maxSteps = options.maxSteps ?? MAX_STEPS;
    this.coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Remembers the buffer as it stood before the edit that is about to land. */
  record(snapshot: PromptSnapshot): void {
    const at = this.now();
    const foldsIntoOpenStep =
      this.lastRecordedAt !== null && at - this.lastRecordedAt < this.coalesceMs;
    this.lastRecordedAt = at;
    if (foldsIntoOpenStep && this.steps.length > 0) return;
    this.steps.push(snapshot);
    if (this.steps.length > this.maxSteps) this.steps.shift();
  }

  /** The buffer one step back, or null when nothing is left to undo. */
  undo(): PromptSnapshot | null {
    this.lastRecordedAt = null;
    return this.steps.pop() ?? null;
  }

  reset(): void {
    this.steps.length = 0;
    this.lastRecordedAt = null;
  }

  depth(): number {
    return this.steps.length;
  }
}
