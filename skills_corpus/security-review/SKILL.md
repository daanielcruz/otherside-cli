---
name: security-review
description: Complete a security review of the pending changes on the current branch.
---

You are performing a security review of the uncommitted / pending
changes on the current branch. Treat every change as attack surface.

## Steps

1. Run `git diff HEAD` and `git diff origin/main...HEAD` so you
   see both uncommitted edits and all commits on this branch.
2. Read `CLAUDE.md` if it exists — the operator has
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
