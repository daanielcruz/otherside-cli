---
name: init-verifiers
description: Create verifier skill(s) for automated verification of code changes.
---

You are scaffolding one or more verifier skills for this project. A
verifier is a skill that asserts a specific behavior holds — e.g.
"the tools module dispatches each of the 9 anchors byte-verbatim"
or "the TUI's autocomplete commits the highlighted slash on Tab".

## Steps

1. Ask the user what behavior the verifier should guard. If they
   already described it, skip the question.
2. Draft the verifier body as a `SKILL.md` under
   `otherside-cli/skills/verifier-<topic>/SKILL.md` with:
   - A frontmatter block naming the verifier.
   - A numbered checklist of assertions the verifier runs.
   - The exact commands the verifier should execute (cargo test,
     tmux capture-pane, grep patterns).
   - Pass/fail criteria for each assertion.
3. The verifier does NOT edit code — it is a read-only diagnostic.
   Its job is to report PASS / PARTIAL / FAIL with evidence.
4. Tests that can live as `cargo test` assertions belong there, not
   in the verifier. The verifier catches bugs that pure-function
   unit tests can't — wiring, rendering, dispatch flow, real-world
   key handling.
5. Register the new verifier in `CLAUDE.md`'s verifier table so
   sessions know it exists.

## Constraints

- One verifier per concern. Don't pile assertions from unrelated
  subsystems into one skill.
- Keep the body under ~80 lines. Deeper procedures go in `docs/`.
- The verifier must be runnable without the user's host tools
  beyond what's in `otherside-cli/`'s toolchain.

## Arguments

Optional — a short description of the subsystem to cover, e.g.
"tool dispatch", "slash autocomplete", "permissions engine".
