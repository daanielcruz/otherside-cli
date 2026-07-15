---
name: code-review
description: Deep code review of a diff. Launches the code-review workflow — finder agents scan each review angle, an independent verifier judges every candidate, then a ranked, capped findings report. Read-only; it reviews, it does not edit.
whenToUse: When the user runs /code-review to review a PR, branch, ref range, path, or the current working changes before merge. Trigger phrases — "code review", "review this PR", "review my changes", "/code-review".
argumentHint: "[pr-number | branch | ref-range | path | instructions]"
userInvocable: true
modelInvocable: false
context: inline
---

The user invoked `/code-review`. Any text in the `<command-args>` block is the
optional review target — a PR number, a branch, a ref range, a path, or a
free-form instruction (e.g. "only review src/foo.ts", "focus on error
handling"). If empty, the workflow reviews the current branch diff.

Your job is **not** to review inline. Launch the bundled `code-review` workflow —
it fans out one finder agent per review angle (correctness + cleanup), streams
each candidate to an independent verifier, optionally sweeps for gaps, then ranks
and caps the findings. You orchestrate it; the agents do the work.

## Launch

Call the `Workflow` tool exactly once:

```
Workflow({ name: "code-review", args: "<level> <target>" })
```

- `<target>` is the user's text from `<command-args>`, passed verbatim (omit to
  review the current branch diff).
- `<level>` is the effort, chosen by you:
  - **high** — a small diff or a single focused change.
  - **xhigh** — a larger or multi-file diff, or an unfamiliar area; adds a
    gap-finding sweep and more verification. **Default to this when unsure.**
  - **max** — a high-risk or critical change where a missed bug is expensive.
- If the user's text already begins with `high`, `xhigh`, or `max`, treat that as
  their explicit choice and pass it through unchanged.

Say at most one line before launching (the level you picked and why), then make
the call. Do not read the diff or review anything yourself first — that is the
workflow's job.

## When it returns

The workflow returns a `summary`, ranked `findings` (each with file, line, and a
failure scenario), the `refuted` candidates, and `stats`. Render the findings for
the user as a clean, readable review — never dump raw JSON. Lead with the
summary, then the findings most-severe first (correctness before cleanup), each
as `file:line — one-line issue` followed by the failure scenario and the fix.
Note how many candidates were refuted during verification.

This is a **review**, not an edit. After presenting it, offer to fix the
findings — but do not change code until the user approves.
