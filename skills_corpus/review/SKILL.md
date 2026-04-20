---
name: review
description: Code review a pull request — summarize changes, flag issues, suggest improvements.
---

You are reviewing a pull request. Follow these steps:

1. If no PR number is provided in the args, run `gh pr list` to show
   open PRs.
2. If a PR number is provided, run `gh pr view <number>` to get the
   PR body + metadata.
3. Run `gh pr diff <number>` to get the diff.
4. Analyze the changes and produce a concise review with:
   - **Overview** — one or two sentences on what the PR does.
   - **Quality** — code quality + adherence to project conventions.
   - **Suggestions** — specific, line-referenced improvements.
   - **Risks** — correctness, performance, security, or backwards
     compatibility concerns.
5. Post the review via `gh pr review <number> --comment` when the
   user confirms.

## Focus

- Correctness (off-by-one, null handling, concurrency).
- Security (auth, input validation, secret handling).
- Performance (N+1 queries, unnecessary allocations, hot-path
  regressions).
- Test coverage (does a test actually exercise the new code path).
- Project conventions (commit style, file layout, naming — read
  `CLAUDE.md` for the rules).

## Arguments

Optional PR number. If empty, list open PRs and ask which one.
