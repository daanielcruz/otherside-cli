---
name: loop
description: Schedule a recurring prompt. Parses `[interval] <prompt>` and registers it as a cron entry.
context: fork
---

# Loop: schedule a recurring prompt

Parse the arguments into `<interval> <prompt>` and schedule it as a cron entry.

## Parsing (priority order)

1. **Leading token**: if the first whitespace-delimited token matches `^\d+[smhd]$` (e.g. `5m`, `2h`, `30s`, `1d`), that's the interval; the rest is the prompt.
2. **Trailing "every" clause**: if the input ends with `every <N><unit>` or `every <N> <unit-word>` (e.g. `every 20m`, `every 5 minutes`, `every 2 hours`), extract that as the interval and strip it from the prompt. Only match when what follows "every" is a time expression — `check every PR` has no interval.

If no interval is found, or the resulting prompt is empty, respond with `Usage: /loop <interval> <prompt>` and stop.

Examples:
- `5m /status` → interval `5m`, prompt `/status` (rule 1)
- `check the build every 20m` → interval `20m`, prompt `check the build` (rule 2)
- `run tests every 5 minutes` → interval `5m`, prompt `run tests` (rule 2)
- `babysit the PRs` → no interval → show usage
- `5m` → empty prompt → show usage

## Convert to a cron expression

| Interval pattern    | Cron expression       | Notes                              |
|---------------------|-----------------------|------------------------------------|
| `Nm` where N ≤ 59  | `*/N * * * *`        | every N minutes                    |
| `Nm` where N ≥ 60  | `0 */H * * *`        | round to hours (H = N/60)          |
| `Nh` where N ≤ 23  | `0 */N * * *`        | every N hours                      |
| `Nd`               | `0 0 */N * *`        | every N days at midnight local     |
| `Ns`               | treat as `ceil(N/60)m`| cron minimum granularity is 1 min  |

If the interval doesn't cleanly divide its unit (e.g. `7m` → `*/7 * * * *` gives uneven gaps at :56→:00, `90m` → 1.5h not expressible), pick the nearest clean interval and mention what you rounded to.

Then:
1. Invoke the `CronCreate` tool with `{cron: "<expression>", prompt: "<parsed prompt>", recurring: true}`.
2. Reply with a single line: `Scheduled cron <id> — runs "<prompt>" every <interval> (cron: <expression>). Cancel with CronDelete.`
3. **Immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke the matching Skill; otherwise act on it directly.

## Rules

- Do NOT invoke any tool other than `CronCreate` for the scheduling step.
- Fixed interval ≥60 minutes is fine — just convert to hours.
- If the user input is `/loop` alone with no args, show usage and stop.
- Use the prompt verbatim. Don't summarize or rewrite it.

## Arguments

Required: `<interval> <prompt>`.
Examples:
- `/loop 5m /status` — fire `/status` every 5 minutes.
- `/loop 30s check build` — fire `check build` every 30 seconds.
- `/loop 1h /pr-review` — fire `/pr-review` every hour.
