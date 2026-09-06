import {
  list as listMainTasks,
  reset as resetMainBoard,
  type TaskRecord,
  taskListIdForScope,
} from "@/engine/background/tasks/index.ts";
import { isInternalTask } from "@/ui/chrome/progress/task-list.ts";

/**
 * How long a fully-completed board lingers before it is wiped. Long enough for
 * the last strike-through to be seen, short enough that a finished plan does not
 * haunt the next one: without the wipe, completed rows from an earlier plan pile
 * up in the session's list and resurface between later tasks.
 */
export const ALL_COMPLETE_RESET_DELAY_MS = 5_000;

export interface AllCompleteResetDeps {
  /** The session board being watched, internal records included. */
  listTasks(): TaskRecord[];
  /** Wipes the board while preserving the id highwatermark. */
  resetBoard(): void;
  /** Which board the session is bound to right now. */
  boardId(): string;
  schedule(fire: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

function defaultDeps(): AllCompleteResetDeps {
  return {
    listTasks: () => listMainTasks(),
    resetBoard: () => resetMainBoard(),
    boardId: () => taskListIdForScope(),
    schedule: (fire, delayMs) => {
      const timer = setTimeout(fire, delayMs);
      timer.unref?.();
      return timer;
    },
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * Retires a board once every task on it is done. `check` runs on each store
 * change: the moment the visible list is non-empty and fully completed, a wipe
 * is armed; any incomplete task appearing before it fires stands it down. The
 * wipe itself re-reads the board — including internal records, which can hold
 * open work the list never shows — and refuses to fire on a board other than
 * the one it was armed for, so a session rebind during the wait cannot get an
 * unrelated board erased.
 */
export class AllCompleteBoardReset {
  private timer: unknown = null;
  private armedBoardId: string | null = null;
  private readonly deps: AllCompleteResetDeps;

  constructor(
    deps: Partial<AllCompleteResetDeps> = {},
    private readonly delayMs = ALL_COMPLETE_RESET_DELAY_MS,
  ) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  check(): void {
    const visible = this.deps.listTasks().filter((task) => !isInternalTask(task));
    const hasIncomplete = visible.some((task) => task.status !== "completed");
    if (hasIncomplete || visible.length === 0) {
      this.disarm();
      return;
    }
    if (this.timer !== null) return;
    this.armedBoardId = this.deps.boardId();
    this.timer = this.deps.schedule(() => this.fire(), this.delayMs);
  }

  dispose(): void {
    this.disarm();
  }

  private fire(): void {
    this.timer = null;
    const armedFor = this.armedBoardId;
    this.armedBoardId = null;
    if (armedFor !== this.deps.boardId()) return;
    const board = this.deps.listTasks();
    const allStillComplete = board.length > 0 && board.every((task) => task.status === "completed");
    if (!allStillComplete) return;
    this.deps.resetBoard();
  }

  private disarm(): void {
    if (this.timer !== null) this.deps.cancel(this.timer);
    this.timer = null;
    this.armedBoardId = null;
  }
}
