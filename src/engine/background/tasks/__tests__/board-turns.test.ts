import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginUserTurnOnBoard, IDLE_TASK_TURNS, SETTLED_TASK_TURNS } from "../board-turns.ts";
import {
  advanceBoardTurn,
  applyTaskUpdate,
  boardTurn,
  clearAll,
  clearScope,
  create,
  get,
  list,
  MAIN_TASK_SCOPE,
  updateTaskRecord,
} from "../index.ts";
import { setTaskOutputSession } from "../output-files.ts";

const SESSION = "board-turns-session";
let root: string;
let savedConfigDir: string | undefined;

function boardDir(): string {
  return join(root, "config", "tasks", SESSION);
}

function turns(count: number): (string | null)[] {
  return Array.from({ length: count }, () => beginUserTurnOnBoard());
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "board-turns-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  clearAll();
  setTaskOutputSession({ sessionId: SESSION, cwd: root });
});

afterEach(() => {
  clearAll();
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(root, { recursive: true, force: true });
});

describe("the board's user turns", () => {
  test("survive a session reload", () => {
    advanceBoardTurn();
    advanceBoardTurn();
    clearScope(MAIN_TASK_SCOPE);
    expect(boardTurn()).toBe(2);
  });

  test("stamp every change with the turn it happened in", () => {
    turns(3);
    const task = create({ subject: "Write the parser", description: "" });
    expect(task.changedAtTurn).toBe(3);
    turns(2);
    expect(updateTaskRecord(task.id, { status: "in_progress" })?.changedAtTurn).toBe(5);
    turns(1);
    expect(applyTaskUpdate(task.id, { subject: "Write the lexer" }, [])?.task.changedAtTurn).toBe(
      6,
    );
  });
});

describe("a completed task", () => {
  test(`retires ${SETTLED_TASK_TURNS} user turns after it was completed`, () => {
    const done = create({ subject: "Land the fix", description: "" });
    const next = create({ subject: "Ship it", description: "" });
    turns(2);
    updateTaskRecord(done.id, { status: "completed" });

    turns(SETTLED_TASK_TURNS - 1);
    expect(get(done.id)).toBeDefined();
    turns(1);
    expect(get(done.id)).toBeUndefined();
    expect(existsSync(join(boardDir(), done.id))).toBe(false);
    expect(get(next.id)).toBeDefined();
    expect(create({ subject: "Later", description: "" }).id).toBe("3");
  });

  test("stays while an open task still names it as a blocker", () => {
    const blocker = create({ subject: "Land the fix", description: "" });
    const blocked = create({ subject: "Ship it", description: "" });
    applyTaskUpdate(blocker.id, { status: "completed" }, [[blocker.id, blocked.id]]);
    turns(SETTLED_TASK_TURNS + 2);
    expect(get(blocker.id)).toBeDefined();

    updateTaskRecord(blocked.id, { status: "completed" });
    turns(SETTLED_TASK_TURNS);
    expect(list()).toEqual([]);
  });

  test("on a board from before turns were counted, retires after that many turns from now", () => {
    mkdirSync(boardDir(), { recursive: true });
    writeFileSync(
      join(boardDir(), "7"),
      JSON.stringify({
        id: "7",
        subject: "Old work",
        description: "",
        status: "completed",
        blocks: [],
        blockedBy: [],
        metadata: {},
      }),
    );
    clearScope(MAIN_TASK_SCOPE);
    turns(SETTLED_TASK_TURNS - 1);
    expect(get("7")).toBeDefined();
    turns(1);
    expect(get("7")).toBeUndefined();
  });
});

describe("an open task left idle", () => {
  test(`is named to the model after ${IDLE_TASK_TURNS} unchanged user turns, then once a window`, () => {
    const idle = create({ subject: "Finish the list", description: "" });
    updateTaskRecord(idle.id, { status: "in_progress" });

    const early = turns(IDLE_TASK_TURNS - 1);
    expect(early.every((reminder) => reminder === null)).toBe(true);
    const [reminder] = turns(1);
    expect(reminder).toContain(
      `#${idle.id} [in_progress] Finish the list — unchanged for ${IDLE_TASK_TURNS} user turns`,
    );
    expect(get(idle.id)?.changedAtTurn).toBe(0);

    expect(turns(IDLE_TASK_TURNS - 1).every((next) => next === null)).toBe(true);
    expect(turns(1)[0]).toContain(`unchanged for ${IDLE_TASK_TURNS * 2} user turns`);
  });

  test("is not named once it changes", () => {
    const task = create({ subject: "Finish the list", description: "" });
    turns(IDLE_TASK_TURNS - 3);
    updateTaskRecord(task.id, { description: "now with a plan" });
    expect(turns(IDLE_TASK_TURNS - 1).every((reminder) => reminder === null)).toBe(true);
  });

  test("is never named when it is internal", () => {
    create({ subject: "Bookkeeping", description: "", metadata: { _internal: true } });
    expect(turns(IDLE_TASK_TURNS + 1).every((reminder) => reminder === null)).toBe(true);
  });

  test("keeps the reminder off the turn the task last changed", () => {
    const task = create({ subject: "Finish the list", description: "" });
    turns(IDLE_TASK_TURNS);
    const stored = JSON.parse(readFileSync(join(boardDir(), task.id), "utf8"));
    expect(stored.remindedAtTurn).toBe(IDLE_TASK_TURNS);
    expect(stored.changedAtTurn).toBe(0);
  });
});
