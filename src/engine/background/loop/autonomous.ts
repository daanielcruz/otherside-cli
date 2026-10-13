import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_AGE_DAYS } from "@/engine/background/cron/index.ts";
import {
  AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
  AUTONOMOUS_LOOP_SENTINEL,
  autonomousDynamicTickReminder,
  autonomousTick,
  autonomousTickReminder,
  LOOP_CRON_TABLE,
  LOOP_FILE_DYNAMIC_SENTINEL,
  LOOP_FILE_SENTINEL,
  LOOP_STOP_OUTCOME,
  LOOP_VISIBLE_UPDATE,
  type LoopFile,
  loopFileAbsentDynamicTickReminder,
  loopFileDynamicTickReminder,
  loopFileTick,
  loopFileTickReminder,
  recurringDefaultLoopPrompt,
  selfPacedDefaultLoopPrompt,
} from "@/harness/skills/loop/prompts.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

const MAX_LOOP_FILE_BYTES = 25_000;
const LEADING_INTERVAL = /^\d+[smhd]$/;
const EVERY_INTERVAL =
  /^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i;

// What the instructions a scheduled default /loop expands into were last delivered
// as: the autonomous check, or a loop-tasks file's contents. A compaction forgets
// them, so the next fire delivers them again.
let autonomousCheckDelivered = false;
let loopFileDelivered: string | null = null;

function truncateLoopFile(raw: string): string {
  if (raw.length <= MAX_LOOP_FILE_BYTES) return raw;
  const cut = raw.lastIndexOf("\n", MAX_LOOP_FILE_BYTES);
  return `${raw.slice(0, cut > 0 ? cut : MAX_LOOP_FILE_BYTES)}\n\n> WARNING: loop.md was truncated to ${MAX_LOOP_FILE_BYTES} bytes. Keep the task list concise.`;
}

function readLoopFileAt(path: string): LoopFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : { path, content: truncateLoopFile(trimmed) };
}

/** The user's loop-tasks file: the project's first, then their own. */
export function readLoopFile(cwd: string): LoopFile | null {
  return (
    readLoopFileAt(join(cwd, ".otherside", "loop.md")) ??
    readLoopFileAt(join(configRoot(), "loop.md"))
  );
}

/** The interval `/loop` was given with no prompt, or null when it was given something else. */
function bareInterval(args: string): string | null {
  if (LEADING_INTERVAL.test(args)) return args;
  const every = EVERY_INTERVAL.exec(args);
  if (!every?.[1] || !every[2]) return null;
  const unit = every[2].toLowerCase()[0] ?? "m";
  return `${every[1]}${"shd".includes(unit) ? unit : "m"}`;
}

/**
 * The /loop skill's instructions for the arguments it was given. With no prompt it
 * runs the default work — the user's loop-tasks file, else the autonomous check —
 * self-paced, or on a cron when only an interval was given.
 */
export function loopSkillPrompt(body: string, rawArgs: string, cwd: string): string {
  const args = rawArgs.trim();
  if (args.length === 0) return selfPacedDefaultLoopPrompt(readLoopFile(cwd));
  const interval = bareInterval(args);
  if (interval !== null) {
    return recurringDefaultLoopPrompt(readLoopFile(cwd), interval, DEFAULT_MAX_AGE_DAYS);
  }
  return body
    .replaceAll("{{LOOP_CRON_TABLE}}", LOOP_CRON_TABLE)
    .replaceAll("{{LOOP_VISIBLE_UPDATE}}", LOOP_VISIBLE_UPDATE)
    .replaceAll("{{LOOP_STOP_OUTCOME}}", LOOP_STOP_OUTCOME);
}

function resolveAutonomousFire(dynamic: boolean): string {
  const reminder = dynamic ? autonomousDynamicTickReminder() : autonomousTickReminder();
  if (autonomousCheckDelivered || loopFileDelivered !== null) return reminder;
  autonomousCheckDelivered = true;
  return autonomousTick(reminder);
}

function resolveLoopFileFire(dynamic: boolean, cwd: string): string {
  const loopFile = readLoopFile(cwd);
  if (loopFile !== null) {
    const reminder = dynamic ? loopFileDynamicTickReminder() : loopFileTickReminder();
    if (loopFileDelivered === loopFile.content) return reminder;
    loopFileDelivered = loopFile.content;
    return loopFileTick(loopFile, reminder);
  }
  const reminder = dynamic ? loopFileAbsentDynamicTickReminder() : autonomousTickReminder();
  if (autonomousCheckDelivered) return reminder;
  autonomousCheckDelivered = true;
  return autonomousTick(reminder);
}

/**
 * What a scheduled prompt says when it fires. A default /loop's placeholder becomes
 * its instructions the first time (and after a compaction or an edited tasks file),
 * then a short reminder that points back at them; any other prompt fires as written.
 */
export function resolveFirePrompt(prompt: string, cwd: string): string {
  switch (prompt) {
    case AUTONOMOUS_LOOP_SENTINEL:
      return resolveAutonomousFire(false);
    case AUTONOMOUS_LOOP_DYNAMIC_SENTINEL:
      return resolveAutonomousFire(true);
    case LOOP_FILE_SENTINEL:
      return resolveLoopFileFire(false, cwd);
    case LOOP_FILE_DYNAMIC_SENTINEL:
      return resolveLoopFileFire(true, cwd);
    default:
      return prompt;
  }
}

/** The conversation was compacted: the next default /loop fire carries its instructions again. */
export function forgetDeliveredLoopInstructions(): void {
  autonomousCheckDelivered = false;
  loopFileDelivered = null;
}
