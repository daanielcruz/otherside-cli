# tool_corpus

**SUPERSEDED BY 010 — see below.**

Byte-match anchors for the tool schemas the model is trained against.
Unlike `config_corpus/` (hand-authored schema fixtures for the config
layer) and `fingerprint_corpus/` (outer-repo captured HTTP traffic),
this corpus is **hand-transcribed from memory of upstream tool
definitions**, `include_str!`'d into the binary so the model receives
the shape it expects.

## Superseded (2026-04-18)

Live capture 2026-04-18 against upstream Claude Code 2.1.113 revealed
that this corpus diverges from upstream's actual advertised tool list:

- This corpus ships: `bash`, `bashoutput`, `edit`, `glob`, `grep`,
  `killbash`, `read`, `task`, `write`.
- Upstream advertises: `Agent`, `Bash`, `Edit`, `Glob`, `Grep`, `Read`,
  `Skill`, `ToolSearch`, `Write`.

Reconciliation tracked under
`openspec/changes/010-harness-tool-list-reconciliation/`. When 010
lands, the authoritative source of truth becomes
`fingerprint_corpus/harness/tools/<ToolName>.json` (produced by change
009's harness-extraction step) and this directory is scheduled for
removal. Until then, the binary STILL `include_str!`'s from here — do
not modify these files lightly, and do not add new tools without
coordinating with 010.

Any divergence here is a harness-fidelity violation — the model
observes the literal `description` and `input_schema` fields when it
decides how and when to call a tool, and upstream trained on specific
strings. Recapture on upstream version bump is the correct way to
evolve this corpus.

## Contents

```
tool_corpus/
├── read.json    — Read tool (file contents)
├── glob.json    — Glob tool (filename pattern matching)
├── grep.json    — Grep tool (ripgrep content search)
└── task.json    — Task tool (subagent dispatch)
```

## Shape

Each file is a JSON object with:

- `name` — tool name string (training anchor, R-20)
- `description` — long-form tool description the model sees when
  deciding whether to call. Multi-paragraph, markdown-flavored.
  Verbatim from upstream.
- `input_schema` — JSON Schema draft-7 describing the tool's args.
  Derived from the upstream Zod schema via manual transcription
  (Zod → JSON Schema has no lossless auto-conversion for all the
  constructs upstream uses — `discriminatedUnion`, `.describe()`
  chains, etc. — so we transcribe).

## Why include_str!, not runtime load

The corpus is compiled INTO the binary — `include_str!` in
`otherside-cli/src/tools/*.rs`. This means:

- A user running otherside against this binary cannot swap in a
  different schema and silently drift the model's behavior.
- `strings(1) otherside` will show the upstream-trained text. That
  is correct — it is the price of faithfulness.
- Binary size grows by a few KB per tool. Acceptable.

## Scrubbing

The `description` text contains the word "Claude Code" in Read's
PDF-support blurb ("This tool allows Claude Code to read images").
Per the 2026-04-18 HARNESS-fidelity directive, tool descriptions
stay upstream-verbatim — the model was trained against those
literal strings. Loss of fidelity = loss of calibration on tool
selection. This is the one class of identity-zone reference that
stays because removing it would degrade behavior.
