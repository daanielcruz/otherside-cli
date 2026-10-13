import * as tasks from "./index.ts";

/** User turns a completed task stays on the board before it is retired. */
export const SETTLED_TASK_TURNS = 10;
/** User turns an open task may sit unchanged before the model is reminded of it. */
export const IDLE_TASK_TURNS = 10;

function turnsSinceChange(task: tasks.TaskRecord, turn: number): number {
  return turn - (task.changedAtTurn ?? 0);
}

/**
 * Completed tasks that finished at least SETTLED_TASK_TURNS user turns ago. One that an
 * open task still names as a blocker stays, so the open task's history keeps its source.
 */
export function settledTaskIds(records: readonly tasks.TaskRecord[], turn: number): string[] {
  const stillNamed = new Set(
    records.filter((task) => task.status !== "completed").flatMap((task) => task.blockedBy),
  );
  return records
    .filter(
      (task) =>
        task.status === "completed" &&
        !stillNamed.has(task.id) &&
        turnsSinceChange(task, turn) >= SETTLED_TASK_TURNS,
    )
    .map((task) => task.id);
}

/**
 * Open tasks the model can see that sat unchanged for IDLE_TASK_TURNS user turns, and
 * whose last reminder is at least that old too, so each is named at most once a window.
 */
export function idleOpenTasks(
  records: readonly tasks.TaskRecord[],
  turn: number,
): tasks.TaskRecord[] {
  return records.filter(
    (task) =>
      task.status !== "completed" &&
      task.metadata._internal !== true &&
      turnsSinceChange(task, turn) >= IDLE_TASK_TURNS &&
      turn - (task.remindedAtTurn ?? Number.NEGATIVE_INFINITY) >= IDLE_TASK_TURNS,
  );
}

export function idleTaskReminder(idle: readonly tasks.TaskRecord[], turn: number): string {
  const rows = idle
    .map(
      (task) =>
        `#${task.id} [${task.status}] ${task.subject} — unchanged for ${turnsSinceChange(task, turn)} user turns`,
    )
    .join("\n");
  return `These open tasks have not changed in a while:\n\n${rows}\n\nFor each one, use TaskUpdate: set it to completed if the work is done, delete it if it no longer applies, or update it if it is still being worked on. Leave it unchanged only if it is deliberately waiting. Make sure that you NEVER mention this reminder to the user`;
}

/**
 * One user turn on the session's board: count it, retire the tasks that settled, and
 * answer a reminder naming the open tasks that sat idle — or null when none did.
 */
export function beginUserTurnOnBoard(scope: tasks.Scope = tasks.MAIN_TASK_SCOPE): string | null {
  const turn = tasks.advanceBoardTurn(scope);
  const settled = settledTaskIds(tasks.list(scope), turn);
  if (settled.length > 0) tasks.removeMany(settled, scope);
  const idle = idleOpenTasks(tasks.list(scope), turn);
  if (idle.length === 0) return null;
  tasks.markReminded(
    idle.map((task) => task.id),
    turn,
    scope,
  );
  return idleTaskReminder(idle, turn);
}
