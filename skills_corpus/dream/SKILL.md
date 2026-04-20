---
name: dream
description: Reflective memory consolidation — review recent activity, synthesize learnings into typed memory files, prune stale entries.
---

You are about to run memory consolidation. The goal is to promote
durable knowledge from the recent session into the file-based memory
system and drop entries that are no longer useful.

## Steps

1. Read the memory index `~/.otherside/projects/<project>/memory/MEMORY.md`
   (or the per-project path the host passes in via args).
2. Read the current project's `CLAUDE.md` and any `AGENTS.md` so you
   don't duplicate what's already authoritative.
3. Scan the most recent conversation turns visible in the harness
   (the last ~20 messages). Identify:
   - User preferences stated explicitly ("always X", "never Y").
   - Stable project facts (paths, versions, deadlines, deliverables).
   - Corrections the user gave you.
   - Non-obvious context that would be useful in a fresh session.
4. For each useful signal, classify as `user`, `feedback`, `project`,
   or `reference` per the memory-type rules in the project's
   `CLAUDE.md`. Skip anything that is already captured.
5. Write each new entry to its own markdown file under the memory
   dir with the required frontmatter, then add a one-line pointer to
   `MEMORY.md`.
6. Walk existing memories. If any contradicts what the user just
   said, delete it (memory decays — trust fresh signals).
7. Report a short summary: N entries added, N updated, N deleted.

## Constraints

- Do not store credentials, tokens, or PII inside memories.
- Keep entries short and retrievable by topic; avoid paragraph-long
  essays — future sessions have limited context.
- If the user invoked `/dream nightly` or `/dream schedule`, schedule
  a recurring consolidation rather than running one now.

## Arguments

Free-form. Common forms: `nightly`, `schedule`, `consolidate`, plain
empty (run immediately).
