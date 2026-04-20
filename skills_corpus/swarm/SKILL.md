---
name: swarm
description: Spin up a multi-agent team to tackle work in parallel — otherside-native.
---

`/swarm` means "start a multi-agent team". Each member is a
subagent you orchestrate via the `TeamCreate`, `SendMessage`, and
`TeamDelete` tools. The user runs this when one task is genuinely
big enough that parallelism helps — large refactors, gap analyses
spanning many modules, heavy research, capture campaigns.

## Protocol — ask before you spawn

**If the user did NOT specify which agents should be in the team**,
your FIRST action is to ask them. Do not invent a roster. Use the
`AskUserQuestion` tool with a short list of sensible defaults
(explorer, planner, reviewer, implementer) plus the free-text
option so they can name their own.

Only after the user names the team do you call `TeamCreate`.

## Steps

1. Determine the team composition (ask if unclear).
2. Call `TeamCreate` with the chosen agent names. Record the team
   id the tool returns.
3. Break the task into independent units of work. Give each agent a
   unit via `SendMessage`. Batch the sends into one tool call when
   the agents can start in parallel.
4. Monitor their progress. `TaskList` / `TaskGet` show their
   shared board; `SendMessage` reaches a specific member.
5. When a member finishes, merge their result into the shared
   output. If two members' work conflicts, resolve it yourself or
   send both a reconcile message.
6. When the work is done, call `TeamDelete` to tear the team down.

## Constraints

- Never spawn a team without the user's explicit green light on
  the roster. Unauthorized fan-out burns tokens and confuses the
  handoff.
- Keep the roster small — 2–5 agents is the sweet spot. Larger
  teams spend more time coordinating than producing.
- Each agent's prompt must be self-contained. Members don't see
  your conversation history; you are the only one with the full
  picture.

## Arguments

Optional — free-form description of the task. If supplied, use it
to shape the team-composition question.
