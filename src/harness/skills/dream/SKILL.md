---
name: dream
aliases: [learn]
description: Reflective memory consolidation — review recent activity, synthesize learnings into the memory directory, and prune stale entries. Use when the user says "dream", "learn", "consolidate memories", "organize your memories", or asks Otherside to reflect on what it has learned.
userInvocable: true
context: fork
---

# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

## Locate the memory directory

The auto-memory subsystem stores this project's memories under:

`{{MEMORY_ROOT}}`

This path is already resolved for the current session — use it verbatim. Never recompute it from the shell's working directory: a `cd` earlier in the session can drift the shell away from the project root and point you at the wrong project.

If your system prompt contains a memory section (`# Memory` or `# auto memory`), the directory is guaranteed to exist — do NOT `mkdir` or check for its existence; write into it directly. Only when that section is absent (auto memory is disabled for this session) may the directory be missing — in that case initialize it, then continue the dream:

- `mkdir -p {{MEMORY_ROOT}}`
- create an empty `{{MEMORY_ROOT}}/MEMORY.md` (the index starts empty; Phase 5 fills it as you write memory files)

On a fresh, empty memory set there is nothing to merge, reconcile, or prune, so the pass is purely additive: gather durable signal (Phase 2), write the first topic files (Phase 3), and register each in `MEMORY.md` (Phase 5).

## Locate the session transcripts

Session JSONL transcripts for this project live in:

`{{TRANSCRIPT_DIR}}/*.jsonl`

Each filename (without `.jsonl`) is the session ID. Each line is a JSON message; user and assistant messages carry a `"content"` field. These files are large — never `cat` whole files. `grep` narrowly.

---

## Phase 1 — Orient

- `ls` the memory directory to see what already exists
- Read `MEMORY.md` to understand the current index
- Skim existing memory files so you improve them rather than creating duplicates

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Existing memories that drifted** — facts that contradict something you see in the codebase now. The current code/docs are authoritative.
2. **Transcript search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
   ```
   grep -rln "<narrow term>" {{TRANSCRIPT_DIR}}/*.jsonl | tail -10
   ```
   Then read the matching files with offset/limit, not whole.

Don't exhaustively read transcripts. Look only for things you already suspect matter — corrections the user made, decisions reached, recurring patterns, gotchas.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory-file format and type conventions from your system prompt's memory section — it is the source of truth for what to save, how to structure it, and what NOT to save.

If your system prompt has no memory section (auto memory disabled this session), use this format — one file per fact, with frontmatter:

{{MEMORY_FORMAT}}

{{MEMORY_DATES_RULE}} If a file or title you produce carries a date, rename it on the spot.

Never save: code structure/conventions (derivable from the repo), git history, fix recipes, anything already in OTHERSIDE.md, or ephemeral task state.

Focus on:

- {{MEMORY_CONSOLIDATION_RULE}}
- When touching a legacy file, **normalize its frontmatter** to the shared format — unless that would drop metadata the format has no field for
- Converting relative dates ("yesterday", "last week") to **absolute dates** so they remain interpretable after time passes
- **Deleting contradicted facts** — if today's investigation disproves an old memory, fix it at the source rather than appending a correction

## Phase 4 — Reconcile against OTHERSIDE.md

Project `OTHERSIDE.md` instructions are loaded in your system prompt. For each `feedback` or `project` memory, check whether it contradicts a `OTHERSIDE.md` instruction on the same topic:

- **Memory is stale** — `OTHERSIDE.md` and the memory describe different procedures for the same task. `OTHERSIDE.md` is the maintained, checked-in source of truth. Delete anything `OTHERSIDE.md` already records; keep the memory only if it carries rationale `OTHERSIDE.md` doesn't — a *why* that changes future behavior — rewritten to that rationale alone.
- **`OTHERSIDE.md` may be stale** — the memory is clearly dated after `OTHERSIDE.md` and explicitly corrects it. Do **NOT** edit `OTHERSIDE.md` during a dream. Annotate the memory with `"contradicts OTHERSIDE.md — verify which is current"` and list it in your summary so the user can update `OTHERSIDE.md` themselves.
- **Not a conflict** — the memory adds detail `OTHERSIDE.md` doesn't cover, or narrows a `OTHERSIDE.md` rule with a stated reason. Leave it.

A `feedback` memory's "Why: the user corrected me" framing is **not evidence** that it's newer than `OTHERSIDE.md` — `OTHERSIDE.md` may have been updated since the correction.

## Phase 5 — Prune and index

Update `MEMORY.md` so it stays:

- under **200 lines** total
- under **~25KB** total
- each entry on **one line** under ~150 characters: `` - [Title](file.md) — one-line hook ``

It's an **index**, not a dump. Never write memory content directly into `MEMORY.md` — content goes in the topic file, the index points at it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Remove memories that fail the consolidation rule's retention test — still TRUE but no longer load-bearing (closed status, fixed-bug debug notes, "I did X" diaries). Review the least-recently-updated files first; git history holds what you prune.
- Demote verbose entries: if an index line is over ~150 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two memory files disagree, fix the wrong one
- Repair `[[name]]` links: after deleting or renaming a memory file, grep the remaining files for `[[<old-name>]]` and update or remove each dangling link

---

## Output

Return a brief summary covering:

- **Consolidated** — N new memories written / merged
- **Updated** — N existing memories edited (with file names)
- **Pruned** — N memories deleted (with file names and one-line reason each)
- **OTHERSIDE.md flags** — any `contradicts OTHERSIDE.md` annotations you added

If nothing changed (memories are already tight), say so plainly — that's a valid outcome.
