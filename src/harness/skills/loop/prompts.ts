import AUTONOMOUS_CHECK_MD from "@/harness/skills/loop/autonomous-check.md" with { type: "text" };

/** What a recurring autonomous /loop passes as its cron prompt; expanded when it fires. */
export const AUTONOMOUS_LOOP_SENTINEL = "<<autonomous-loop>>";
/** The same for a self-paced autonomous /loop's wakeups. */
export const AUTONOMOUS_LOOP_DYNAMIC_SENTINEL = "<<autonomous-loop-dynamic>>";
/** What a recurring /loop running the user's loop-tasks file passes as its cron prompt. */
export const LOOP_FILE_SENTINEL = "<<loop.md>>";
/** The same for a self-paced /loop running the loop-tasks file. */
export const LOOP_FILE_DYNAMIC_SENTINEL = "<<loop.md-dynamic>>";

export const AUTONOMOUS_CHECK = AUTONOMOUS_CHECK_MD.trim();

export const LOOP_CRON_TABLE = `| Interval pattern      | Cron expression     | Notes                                    |
|-----------------------|---------------------|------------------------------------------|
| \`Nm\` where N ≤ 59   | \`*/N * * * *\`     | every N minutes                          |
| \`Nm\` where N ≥ 60   | \`0 */H * * *\`     | round to hours (H = N/60, must divide 24)|
| \`Nh\` where N ≤ 23   | \`0 */N * * *\`     | every N hours                            |
| \`Nd\`                | \`0 0 */N * *\`     | every N days at midnight local           |
| \`Ns\`                | treat as \`ceil(N/60)m\` | cron minimum granularity is 1 minute  |

**If the interval doesn't cleanly divide its unit** (e.g. \`7m\` → \`*/7 * * * *\` gives uneven gaps at :56→:00; \`90m\` → 1.5h which cron can't express), pick the nearest clean interval and tell the user what you rounded to before scheduling.`;

export const LOOP_VISIBLE_UPDATE =
  "This must be ordinary visible response text — the user cannot see your thinking/reasoning, so an update written only there is invisible to them.";

export const LOOP_STOP_OUTCOME =
  "Then write the loop's outcome for the user as ordinary visible response text — a stopped loop has no next tick to surface it.";

const NOOP_FIELD =
  '   - `noop`: `true` if this tick changed nothing ("still waiting", "quiet hold"); `false` if it did something worth keeping. Consecutive `noop: true` ticks collapse in the terminal.';

export interface LoopFile {
  path: string;
  content: string;
}

function instructionsSection(loopFile: LoopFile | null): string {
  return loopFile !== null
    ? `## Loop tasks (from ${loopFile.path})\n\n${loopFile.content}`
    : `## Autonomous-loop instructions (for the immediate execution and every fire)\n\n${AUTONOMOUS_CHECK}`;
}

function workName(loopFile: LoopFile | null): string {
  return loopFile !== null ? "the loop.md tasks" : "the autonomous check";
}

/** `/loop` with no prompt and no interval: run the work now, then self-pace it. */
export function selfPacedDefaultLoopPrompt(loopFile: LoopFile | null): string {
  const sentinel =
    loopFile !== null ? LOOP_FILE_DYNAMIC_SENTINEL : AUTONOMOUS_LOOP_DYNAMIC_SENTINEL;
  const heading =
    loopFile !== null
      ? `# /loop — loop.md tasks with dynamic pacing\n\nThe user invoked \`/loop\` with no prompt and no interval and has a loop-tasks file at \`${loopFile.path}\`. Run those tasks now, then self-pace the next iteration via ScheduleWakeup — no cron.`
      : "# /loop — autonomous default with dynamic pacing\n\nThe user invoked `/loop` with no prompt and no interval. Run the autonomous check now, then self-pace the next iteration via ScheduleWakeup — no cron.";
  const confirmed =
    loopFile !== null
      ? `that you're running tasks from \`${loopFile.path}\` in dynamic-pacing mode, that you ran the first tick now`
      : "that this is the autonomous default in dynamic-pacing mode, that you ran the check now";
  const action = [
    `1. **Run ${workName(loopFile)} now**, following the instructions inlined below.`,
    `2. **Decide whether the loop continues.** If the next check is worth running, call ScheduleWakeup with:
   - \`delaySeconds\`: pick based on what you observed this turn — quiet branch? wait longer. Lots in flight? wait shorter. Background work you started notifies you automatically (\`<task-notification>\` wakes the loop immediately), so a wakeup is only the fallback heartbeat for that. Read the tool's own description for cache-aware delay guidance.
   - \`reason\`: one short sentence on why you picked that delay.
   - \`prompt\`: the literal string \`${sentinel}\` — the dynamic-mode sentinel expands at fire time to the full instructions (first fire / first fire post-compact / loop.md edited) or a dynamic-pacing-specific short reminder (subsequent fires). Do not pass the full instructions; that is handled automatically.
${NOOP_FIELD}
   If it isn't, stop instead (step 5) — re-arming is a per-turn choice, not a default.`,
    `3. **After the wakeup is armed, briefly confirm**: ${confirmed}, and what delay you picked. ${LOOP_VISIBLE_UPDATE} Make it the last thing in the turn, then end the turn.`,
    `4. **If woken by a \`<task-notification>\`** rather than this prompt: handle the event, then make the same decision. If the loop should continue, call ScheduleWakeup again with \`${sentinel}\` and a 1200–1800s \`delaySeconds\` (notifications remain the wake signal; the new wakeup is only the fallback heartbeat), then write the same brief update as visible text. If the event means the work is finished, stop (step 5).`,
    `5. **To stop the loop** — the task is complete, further iterations can't make progress, or the user asked you to stop — call ScheduleWakeup with \`stop: true\` (no other fields). ${LOOP_STOP_OUTCOME} Stopping is the loop's normal ending — the user can restart it anytime with /loop.`,
  ].join("\n");
  return `${heading}\n\n## Action\n\n${action}\n\n${instructionsSection(loopFile)}`;
}

/** `/loop <interval>` with no prompt: schedule the work on a cron, then run the first tick now. */
export function recurringDefaultLoopPrompt(
  loopFile: LoopFile | null,
  interval: string,
  maxAgeDays: number,
): string {
  const sentinel = loopFile !== null ? LOOP_FILE_SENTINEL : AUTONOMOUS_LOOP_SENTINEL;
  const heading =
    loopFile !== null
      ? `# /loop — schedule loop.md tasks\n\nThe user invoked \`/loop\` with no prompt (input was empty or just the interval \`${interval}\`) and has a loop-tasks file at \`${loopFile.path}\`. Schedule a recurring cron that runs those tasks each tick, then run the first tick immediately.`
      : `# /loop — schedule the autonomous default\n\nThe user invoked \`/loop\` with no prompt (input was empty or just the interval \`${interval}\`). Schedule the autonomous-loop default and then run the first autonomous check immediately.`;
  const expands =
    loopFile !== null
      ? "it expands at fire time to the full loop.md contents on first delivery (and whenever loop.md has been edited since last fire), and to a short reminder on subsequent unchanged fires. The long instructions stay in the cached message-prefix."
      : "it expands at fire time to the full autonomous-loop instructions on first delivery, and to a short reminder on subsequent fires (the long instructions stay in the cached message-prefix).";
  const confirm =
    loopFile !== null
      ? `what's scheduled, the cron expression, the human-readable cadence, that it's running tasks from \`${loopFile.path}\`, that recurring tasks auto-expire after ${maxAgeDays} days, and that the user can cancel sooner with CronDelete (include the job ID).`
      : `what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after ${maxAgeDays} days, and that they can cancel sooner with CronDelete (include the job ID). Mention this is the autonomous default and that the autonomous-loop instructions are baked in.`;
  const action = [
    `1. Convert \`${interval}\` to a 5-field cron expression. Supported suffixes: \`s\` → ceil to nearest minute, \`m\` (minutes), \`h\` (hours), \`d\` (days). Examples: \`5m\` → \`*/5 * * * *\`, \`1h\` → \`0 * * * *\`, \`1d\` → \`0 0 * * *\`. If the interval doesn't cleanly divide its unit, round to the nearest clean interval and tell the user what you rounded to.`,
    `2. Call CronCreate with:
   - \`cron\`: the expression from step 1
   - \`prompt\`: the literal string \`${sentinel}\` — ${expands}
   - \`recurring\`: \`true\``,
    `3. Briefly confirm: ${confirm}`,
    `4. **Then immediately run ${workName(loopFile)} now**, following the instructions inlined below. Don't wait for the first cron fire.`,
  ].join("\n");
  return `${heading}\n\n## Action\n\n${action}\n\n${instructionsSection(loopFile)}`;
}

const RESCHEDULE_DYNAMIC = (sentinel: string): string =>
  `You scheduled this tick via the ScheduleWakeup tool (not a recurring cron). To keep the loop alive, call ScheduleWakeup again at the end of this turn with \`prompt\` set to the literal sentinel \`${sentinel}\` and \`noop\` set to \`true\` if this tick changed nothing (or \`false\` if it did) — otherwise the loop ends after this tick.`;

const CRON_FIRES_NEXT =
  "The recurring cron will fire the next tick automatically — do not call ScheduleWakeup from this tick.";

/** The short reminder a recurring autonomous tick carries once the instructions were delivered. */
export function autonomousTickReminder(): string {
  return `# Autonomous loop tick\n\nRun the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. ${CRON_FIRES_NEXT}`;
}

export function autonomousDynamicTickReminder(): string {
  return `# Autonomous loop tick (dynamic pacing)\n\nRun the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.\n\n${RESCHEDULE_DYNAMIC(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)}`;
}

export function loopFileTickReminder(): string {
  return `# /loop tick — loop.md tasks\n\nWork the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick. ${CRON_FIRES_NEXT}`;
}

export function loopFileDynamicTickReminder(): string {
  return `# /loop tick — loop.md tasks (dynamic pacing)\n\nWork the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick.\n\n${RESCHEDULE_DYNAMIC(LOOP_FILE_DYNAMIC_SENTINEL)}`;
}

export function loopFileAbsentDynamicTickReminder(): string {
  return `# /loop tick — loop.md absent (dynamic pacing)\n\nloop.md is not currently present. Run the autonomous check using the loop instructions established earlier in this conversation.\n\nYou scheduled this tick via the ScheduleWakeup tool (not a recurring cron). To keep the loop alive — and to pick up loop.md if it is recreated — call ScheduleWakeup again at the end of this turn with \`prompt\` set to the literal sentinel \`${LOOP_FILE_DYNAMIC_SENTINEL}\` and \`noop\` set to \`true\` if this tick changed nothing (or \`false\` if it did) — otherwise the loop ends after this tick.`;
}

/** The first tick of a loop-tasks file, or of an edited one: its full contents, then the reminder. */
export function loopFileTick(loopFile: LoopFile, reminder: string): string {
  return `# /loop tick — tasks from ${loopFile.path}\n\nThe user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).\n\n---\n\n${loopFile.content}\n\n---\n\n${reminder}`;
}

/** The first autonomous tick after the instructions were last delivered: all of them, then the reminder. */
export function autonomousTick(reminder: string): string {
  return `${AUTONOMOUS_CHECK}\n\n---\n\n${reminder}`;
}
