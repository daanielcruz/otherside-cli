---
name: loop
description: Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.
aliases: proactive
argumentHint: "[interval] <prompt>"
whenToUse: 'When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke for one-off tasks.'
context: inline
---

# /loop — schedule a recurring or self-paced prompt

Parse the input (in `<command-args>`) into `[interval] <prompt…>` and schedule it.

## Parsing (in priority order)

1. **Leading token**: if the first whitespace-delimited token matches `^\d+[smhd]$` (e.g. `5m`, `2h`), that's the interval; the rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with `every <N><unit>` or `every <N> <unit-word>` (e.g. `every 20m`, `every 5 minutes`, `every 2 hours`), extract that as the interval and strip it from the prompt. Only match when what follows "every" is a time expression — `check every PR` has no interval.
3. **No interval**: otherwise, the entire input is the prompt and you'll self-pace dynamically (see "Dynamic mode" below).

If the resulting prompt is empty, show this usage and stop:

```
Usage: /loop [interval] <prompt>

Run a prompt or slash command on a recurring interval — or with no interval, let the model self-pace based on the task.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum granularity is 1 minute.
If no interval is specified, the model picks a delay between iterations based on what it's doing.

Examples:
  /loop 5m /babysit-prs
  /loop 30m check the deploy
  /loop 1h /standup 1
  /loop check the deploy          (dynamic — model picks delays)
  /loop check the deploy every 20m
```

Examples:
- `5m /babysit-prs` → interval `5m`, prompt `/babysit-prs` (rule 1)
- `check the deploy every 20m` → interval `20m`, prompt `check the deploy` (rule 2)
- `run tests every 5 minutes` → interval `5m`, prompt `run tests` (rule 2)
- `check the deploy` → no interval → dynamic mode, prompt `check the deploy` (rule 3)
- `check every PR` → no interval → dynamic mode, prompt `check every PR` (rule 3 — "every" not followed by time)
- `5m` → empty prompt → show usage

## Fixed-interval mode (rules 1 and 2)

Convert the interval to a cron expression:

| Interval pattern      | Cron expression     | Notes                                    |
|-----------------------|---------------------|------------------------------------------|
| `Nm` where N ≤ 59   | `*/N * * * *`     | every N minutes                          |
| `Nm` where N ≥ 60   | `0 */H * * *`     | round to hours (H = N/60, must divide 24)|
| `Nh` where N ≤ 23   | `0 */N * * *`     | every N hours                            |
| `Nd`                | `0 0 */N * *`     | every N days at midnight local           |
| `Ns`                | treat as `ceil(N/60)m` | cron minimum granularity is 1 minute  |

**If the interval doesn't cleanly divide its unit** (e.g. `7m` → `*/7 * * * *` gives uneven gaps at :56→:00; `90m` → 1.5h which cron can't express), pick the nearest clean interval and tell the user what you rounded to before scheduling.

Then:
1. Call CronCreate with: `cron` (the expression above), `prompt` (the parsed prompt verbatim), `recurring: true`.
2. Briefly confirm: what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after 7 days, and that the user can cancel sooner with CronDelete (include the job ID).
3. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.

## Dynamic mode (rule 3 — no interval)

The user wants you to self-pace. Decide what makes the next iteration worth running — a passage of time, or an observable event.

1. **Run the parsed prompt now.** If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.
2. **Briefly confirm**: that you're self-pacing, that you ran the task now, and what delay you're about to pick. Write this as text *before* calling ScheduleWakeup — the turn ends as soon as that tool returns.
3. **Then, as the last action of this turn, decide whether the loop continues.** If the task needs another iteration, call ScheduleWakeup with:
   - `delaySeconds`: the cadence — pick based on what you observed. Background work you started notifies you automatically (`<task-notification>` wakes the loop immediately), so a wakeup is only the fallback heartbeat for that; lean 1200–1800s unless you're actively polling external state the harness can't track. Read the tool's own description for cache-aware delay guidance.
   - `reason`: one short sentence on why you picked that delay.
   - `prompt`: the full original /loop input verbatim, prefixed with `/loop ` so the next firing re-enters this skill and continues the loop. For example, if the user typed `/loop check the deploy`, pass `/loop check the deploy` as the prompt.
   If it doesn't need another iteration, stop instead (step 5) — re-arming is a per-turn choice, not a default.
4. **If you were woken by a `<task-notification>`** rather than this prompt: handle the event in the context of the loop task, then make the same decision. If the loop should continue, call ScheduleWakeup again with the same `prompt` and a 1200–1800s `delaySeconds` (notifications remain the wake signal; the new wakeup is only the fallback heartbeat). If the event means the work is finished, stop (step 5).
5. **To stop the loop** — the task is complete, further iterations can't make progress, or the user asked you to stop — call ScheduleWakeup with `stop: true` (no other fields). Stopping is the loop's normal ending — the user can restart it anytime with /loop.

## Rules

- Use the prompt verbatim. Don't summarize or rewrite it.
- A dynamic loop fires as a message that starts with `/loop ` — re-enter this skill via the Skill tool and continue at "Dynamic mode" (the loop is already running; don't re-confirm the setup).
