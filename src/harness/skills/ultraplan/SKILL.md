---
name: ultraplan
description: Deep, multi-agent implementation planning. Launches the ultraplan workflow — explorer agents map the codebase, competing approaches are drafted and independently critiqued, then merged into one ordered, verifiable plan. Read-only; it designs, it does not write code.
whenToUse: When the user runs /ultraplan <task> to get a thorough implementation plan for a non-trivial change before any code is written.
argumentHint: <what to plan>
userInvocable: true
modelInvocable: false
context: inline
---

The user invoked `/ultraplan`. The planning task is the text inside the
`<command-args>` block above. That text is the prompt — it is **mandatory**.

If `<command-args>` is empty or missing, do not launch anything: reply with one
line asking what they want planned (e.g. "What should I plan? Run `/ultraplan
<task>` — a feature, a refactor, or a scoped instruction."), then stop.

Otherwise your job is **not** to plan inline yourself. Launch the bundled
`ultraplan` workflow — it fans out explorer agents over the codebase, drafts
competing approaches, critiques each independently, and synthesizes one ordered
plan. You orchestrate it; the agents do the work.

## Launch

Call the `Workflow` tool exactly once:

```
Workflow({ name: "ultraplan", args: "<level> <task>" })
```

- `<task>` is the user's text from `<command-args>`, passed verbatim.
- `<level>` is the effort, chosen by you:
  - **high** — small, localized change (one or two files, a clear seam).
  - **xhigh** — multi-file or non-obvious change, unfamiliar area, or anything
    where a second opinion pays off. **Default to this when unsure** — planning
    is where critique earns its cost.
  - **max** — architectural, cross-cutting, or high-risk work where getting the
    shape wrong is expensive.
- If the user's text already begins with `high`, `xhigh`, or `max`, treat that
  as their explicit choice and pass it through unchanged.

Say at most one line before launching (which level you picked and why), then
make the call. Do not explore, read files, or draft the plan yourself first —
that is the workflow's job, and doing it inline wastes the run.

## When it returns

The workflow returns a structured plan: context, the chosen approach, an ordered
step list naming files, a dependency diagram, reuse notes, risks, a verification
section, and open questions. Render it for the user as a clean, readable plan —
never dump the raw JSON. Lead with the context and approach, then the ordered
steps, then risks + verification. Surface the open questions plainly.

This is a **design**, not an edit. After presenting it, offer to implement it —
but do not start changing code until the user approves. If they approve, follow
the plan's steps in order.

## Tailoring (rare)

Prefer launching the named `ultraplan` scaffold above — it fits almost every
"plan a code change" request. Only when the task needs a materially different
shape (a research plan, a migration sweep, an ops runbook — something the
explore → design → critique → synthesize structure does not serve) should you
instead author a bespoke `Workflow({ script: ... })`, modeling it on the
ultraplan scaffold's phase structure rather than launching it by name.
