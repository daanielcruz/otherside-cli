---
name: init
description: Initialize a new OTHERSIDE.md file with codebase documentation for cold-start sessions.
---

You are creating `OTHERSIDE.md` for the current project. This file
is the cold-start anchor — fresh sessions read it to orient
themselves without re-exploring the codebase.

## Steps

1. Walk the repo top-down: read the root `README.md`, `Cargo.toml`
   (or equivalent manifest), and the entry-point source file(s).
2. Identify:
   - What the project is — one sentence.
   - Primary language / runtime / framework.
   - Build + test commands.
   - Directory layout (top 5–10 most important folders).
   - Pre-flight commands a new session should run.
   - Hard rules the operator cares about (e.g. "never commit X").
3. Write `OTHERSIDE.md` at the repo root with the following shape:

```markdown
# OTHERSIDE.md

## What this is
One-sentence purpose.

## Pre-flight
```bash
<commands a new session should run>
```

## Layout
- `path/` — purpose
- ...

## Rules
- Hard rule 1
- Hard rule 2
```

4. Keep the file short — under 80 lines. Longer content belongs in
   `docs/`. Link to those from here if they already exist.
5. Do NOT include credentials, internal URLs, or anything that
   shouldn't live in a public repo. If in doubt, ask the user.

## Arguments

None normally. If the user passes a path, write there instead of
the repo root.
