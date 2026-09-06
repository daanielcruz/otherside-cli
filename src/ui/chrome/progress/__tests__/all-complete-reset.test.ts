import { describe, expect, it } from "bun:test";
import type { TaskRecord, TaskStatus } from "@/engine/background/tasks/index.ts";
import {
  ALL_COMPLETE_RESET_DELAY_MS,
  AllCompleteBoardReset,
} from "@/ui/chrome/progress/all-complete-reset.ts";

function task(id: string, status: TaskStatus, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    subject: `task ${id}`,
    description: "",
    status,
    blocks: [],
    blockedBy: [],
    metadata: {},
    ...extra,
  };
}

/** A deterministic timer host: fire() runs whatever wipe is currently armed. */
class ManualTimers {
  private pending = new Map<number, () => void>();
  private seq = 0;
  lastDelay: number | null = null;

  schedule = (fire: () => void, delayMs: number): unknown => {
    this.lastDelay = delayMs;
    this.seq += 1;
    this.pending.set(this.seq, fire);
    return this.seq;
  };

  cancel = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  get armed(): boolean {
    return this.pending.size > 0;
  }

  fire(): void {
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const job of jobs) job();
  }
}

function harness(options: { board: () => TaskRecord[]; boardId?: () => string }) {
  const timers = new ManualTimers();
  let resets = 0;
  const watcher = new AllCompleteBoardReset({
    listTasks: options.board,
    resetBoard: () => {
      resets += 1;
    },
    boardId: options.boardId ?? (() => "board-1"),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  return { watcher, timers, resetCount: () => resets };
}

describe("AllCompleteBoardReset", () => {
  it("wipes a fully-completed board once the delay elapses", () => {
    const board = [task("1", "completed"), task("2", "completed")];
    const { watcher, timers, resetCount } = harness({ board: () => board });

    watcher.check();
    expect(timers.armed).toBe(true);
    expect(timers.lastDelay).toBe(ALL_COMPLETE_RESET_DELAY_MS);

    timers.fire();
    expect(resetCount()).toBe(1);
  });

  it("stands down when new work lands before the wipe", () => {
    let board = [task("1", "completed")];
    const { watcher, timers, resetCount } = harness({ board: () => board });

    watcher.check();
    expect(timers.armed).toBe(true);

    board = [task("1", "completed"), task("2", "pending")];
    watcher.check();
    expect(timers.armed).toBe(false);

    timers.fire();
    expect(resetCount()).toBe(0);
  });

  it("never arms for an empty or still-open board", () => {
    let board: TaskRecord[] = [];
    const { watcher, timers } = harness({ board: () => board });

    watcher.check();
    expect(timers.armed).toBe(false);

    board = [task("1", "in_progress")];
    watcher.check();
    expect(timers.armed).toBe(false);
  });

  it("does not re-arm a second timer while one is already running", () => {
    const board = [task("1", "completed")];
    const { watcher, timers, resetCount } = harness({ board: () => board });

    watcher.check();
    watcher.check();
    timers.fire();
    expect(resetCount()).toBe(1);
  });

  it("refuses to wipe when the session rebound to another board mid-wait", () => {
    let boardId = "board-1";
    const { watcher, timers, resetCount } = harness({
      board: () => [task("1", "completed")],
      boardId: () => boardId,
    });

    watcher.check();
    boardId = "board-2";
    timers.fire();
    expect(resetCount()).toBe(0);
  });

  it("re-verifies at fire time and spares a board that reopened work", () => {
    let board = [task("1", "completed")];
    const { watcher, timers, resetCount } = harness({ board: () => board });

    watcher.check();
    // The board changed under the timer without another check() call.
    board = [task("1", "in_progress")];
    timers.fire();
    expect(resetCount()).toBe(0);
  });

  it("counts hidden internal records when deciding whether all work is done", () => {
    const board = [
      task("1", "completed"),
      task("2", "in_progress", { metadata: { _internal: true } }),
    ];
    const { watcher, timers, resetCount } = harness({ board: () => board });

    // The visible list is fully complete, so the wipe arms…
    watcher.check();
    expect(timers.armed).toBe(true);

    // …but the fire-time audit sees the open internal record and spares the board.
    timers.fire();
    expect(resetCount()).toBe(0);
  });

  it("dispose cancels an armed wipe", () => {
    const { watcher, timers, resetCount } = harness({
      board: () => [task("1", "completed")],
    });

    watcher.check();
    watcher.dispose();
    expect(timers.armed).toBe(false);
    timers.fire();
    expect(resetCount()).toBe(0);
  });
});
