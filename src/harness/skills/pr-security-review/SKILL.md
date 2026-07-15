---
name: pr-security-review
description: Complete a security review of the pending changes on the current branch.
userInvocable: true
context: fork
---

You are performing a security review of the uncommitted / pending
changes on the current branch. Treat every change as attack surface.

## Branch state

```
!`git status -s`
```

## Files modified

```
!`git diff --name-only origin/HEAD... 2>/dev/null || git diff --name-only HEAD`
```

## Diff

```
!`git diff origin/HEAD... 2>/dev/null || git diff HEAD`
```

## Steps

1. Review the diff above — that is the complete attack surface.
2. Read `OTHERSIDE.md` if it exists — the operator has
   scope-specific rules that override generic best-practice.
3. For each change, check:
   - **Injection** — SQL, shell, LDAP, XPath, template, command.
   - **Authentication / authorization** — new endpoints or code
     paths that should be gated, bypasses, privilege escalation.
   - **Secrets** — keys, tokens, passwords hardcoded; logging of
     sensitive values; credentials in the commit message or diff.
   - **Deserialization** — user-controlled input parsed into
     executable / reflective structures.
   - **XXE / SSRF** — XML parsing, URL fetching, DNS lookups on
     untrusted input.
   - **Path traversal** — `fs::read`, `open`, `include_str!` on
     user-controlled paths.
   - **Race conditions** — TOCTOU, shared-state mutation without
     locks.
   - **Crypto** — custom crypto, weak primitives, ECB, static IVs,
     predictable nonces, low-iteration KDFs.
   - **Dependencies** — new crates / packages; check if any are
     deprecated or carry known CVEs.
4. Produce a report with one section per category above, listing
   findings at file:line with **severity** (critical / high /
   medium / low / info) and a concrete fix.
5. If no issues in a category, say "clean — <one-line reason>".
6. Write the full report to
   `{{REPORTS_DIR}}/pr-security-review-{{REPORT_TIMESTAMP}}.md` via
   the `Write` tool. Use the output format below. This is the
   canonical artifact — do not dump findings into your final
   assistant message.
7. Return a short summary (2-4 lines). EVERY field is MANDATORY — do
   not omit any:
   - branch name
   - severity tally: `N critical · N high · N medium · N low · N info`
   - absolute path to the written report file — copy the exact path
     you passed to `Write`, prefixed with `Report: `. Never omit this
     line.
   - Example:
     `Security review on <branch> — 1 high, 2 medium, 4 low.
     Report: /Users/.../reports/pr-security-review-2026-05-12T18-30-00.md`.
   A reply that lacks the `Report:` line with an absolute filesystem
   path is incomplete and MUST be revised before sending.

## Output format

```
# Security review — <branch>

## Summary
- N critical · N high · N medium · N low · N info

## Findings
### <category>
- **<severity>** `<file>:<line>` — <one-line summary>
  - Why: <explanation>
  - Fix: <specific change>
```

## Arguments

None. Operates on the current branch vs `origin/main`.