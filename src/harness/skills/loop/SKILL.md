---
name: loop
description: Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.
menuDescription: Repeat a prompt or command on an interval (e.g. /loop 5m /foo)
aliases: proactive
argumentHint: "[interval] [prompt]"
whenToUse: 'When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke for one-off tasks.'
context: inline
---

# /loop — schedule a recurring or self-paced prompt

Parse the input (in `<command-args>`) into `[interval] <prompt…>` and schedule it.

## Parsing (in priority order)

1. **Leading token**: if the first whitespace-delimited token matches `^\d+[smhd]$` (e.g. `5m`, `2h`), that's the interval; the rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with `every <N><unit>` or `every <N> <unit-word>` (e.g. `every 20m`, `every 5 minutes`, `every 2 hours`), extract that as the interval and strip it from the prompt. Only match when what follows "every" is a time expression — `check every PR` has no interval.
3. **No interval**: otherwise, the entire input is the prompt and you'll self-pace dynamically (see "Dynamic mode" below).

If the resulting prompt is empty, show usage `/loop [interval] <prompt>` and stop.

Examples:
- `5m /babysit-prs` → interval `5m`, prompt `/babysit-prs` (rule 1)
- `check the deploy every 20m` → interval `20m`, prompt `check the deploy` (rule 2)
- `run tests every 5 minutes` → interval `5m`, prompt `run tests` (rule 2)
- `check the deploy` → no interval → dynamic mode, prompt `check the deploy` (rule 3)
- `check every PR` → no interval → dynamic mode, prompt `check every PR` (rule 3 — "every" not followed by time)
- `5m` → empty prompt → show usage

## Fixed-interval mode (rules 1 and 2)

Convert the interval to a cron expression:

{{LOOP_CRON_TABLE}}

Then:
1. Call CronCreate with: `cron` (the expression above), `prompt` (the parsed prompt verbatim), `recurring: true`.
2. Briefly confirm: what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after 7 days, and that the user can cancel sooner with CronDelete (include the job ID).
3. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.

## Dynamic mode (rule 3 — no interval)

The user wants you to self-pace. Decide what makes the next iteration worth running — a passage of time, or an observable event.

1. **Run the parsed prompt now.** If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.
2. **Decide whether the loop continues.** If the task needs another iteration, call ScheduleWakeup with:
   - `delaySeconds`: the cadence — pick based on what you observed. Background work you started notifies you automatically (`<task-notification>` wakes the loop immediately), so a wakeup is only the fallback heartbeat for that; lean 1200–1800s unless you're actively polling external state the harness can't track. Read the tool's own description for cache-aware delay guidance.
   - `reason`: one short sentence on why you picked that delay.
   - `prompt`: the full original /loop input verbatim, prefixed with `/loop ` so the next firing re-enters this skill and continues the loop. For example, if the user typed `/loop check the deploy`, pass `/loop check the deploy` as the prompt.
   - `noop`: `true` if this tick changed nothing ("still waiting", "quiet hold"); `false` if it did something worth keeping. Consecutive `noop: true` ticks collapse in the terminal.
   If it doesn't need another iteration, stop instead (step 5) — re-arming is a per-turn choice, not a default.
3. **After the wakeup is armed, briefly confirm**: that you're self-pacing, that you ran the task now, and what delay you picked. {{LOOP_VISIBLE_UPDATE}} Make it the last thing in the turn, then end the turn.
4. **If you were woken by a `<task-notification>`** rather than this prompt: handle the event in the context of the loop task, then make the same decision. If the loop should continue, call ScheduleWakeup again with the same `prompt` and a 1200–1800s `delaySeconds` (notifications remain the wake signal; the new wakeup is only the fallback heartbeat), then write the same brief update as visible text. If the event means the work is finished, stop (step 5).
5. **To stop the loop** — the task is complete, further iterations can't make progress, or the user asked you to stop — call ScheduleWakeup with `stop: true` (no other fields). {{LOOP_STOP_OUTCOME}} Stopping is the loop's normal ending — the user can restart it anytime with /loop.
