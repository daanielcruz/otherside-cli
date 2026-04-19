# harness_corpus — wire-fidelity artifacts the binary ships

Byte-verbatim building blocks of the outbound `/v1/messages` body.
`otherside-cli/src/harness/*.rs` embeds these via `include_str!` at
compile time — no runtime I/O, no external file dependency, the inner
crate compiles standalone.

Source: live-capture from upstream Claude Code 2.1.113 (2026-04-18),
scrubbed per the outer-repo `docs/capture-protocol.md`.

## Layout

```
harness_corpus/
├── envelope.json               request body envelope (metadata,
│                               max_tokens, thinking,
│                               context_management, output_config,
│                               stream) — capture key order
├── system-prompt.md            main ~16 KB agent system prompt
├── system-preamble.json        billing header + two pre-prompt
│                               blocks (3-entry system[] array prefix)
├── system-reminders/           three <system-reminder>-wrapped blocks
│                               prepended to the first user turn
│   ├── deferred-tools.txt        notice about tools not loaded yet
│   ├── skills.txt                available skills catalog (bundled
│                                 skills the model may invoke as
│                                 type: 'prompt' macros — distinct
│                                 from the local TUI slash catalog
│                                 in src/tui/slash_catalog.rs)
│   └── user-context.tmpl         template with {{email}} +
│                                 {{current_date}} placeholders
└── tools/                      9 tool schemas advertised on the wire
                                in canonical order (tool names are
                                R-20 training anchors — DO NOT rename)
    ├── Agent.json
    ├── Bash.json
    ├── Edit.json
    ├── Glob.json
    ├── Grep.json
    ├── Read.json
    ├── Skill.json
    ├── ToolSearch.json
    └── Write.json
```

## Inspection map — which file answers which question

| question                                            | inspect                                       |
|-----------------------------------------------------|-----------------------------------------------|
| what agent instructions does the model receive?     | `system-prompt.md`                            |
| which billing + pre-prompt headers ride the body?   | `system-preamble.json`                        |
| what `system-reminder` blocks prepend turn 1?       | `system-reminders/*.{txt,tmpl}`               |
| which tools are advertised on the wire?             | `tools/*.json` (9 files; order locked)        |
| what are the body envelope defaults?                | `envelope.json`                               |
| which bundled skills can the model invoke?          | `system-reminders/skills.txt`                 |
| which local slashes does the TUI handle?            | `src/tui/slash_catalog.rs::CATALOG` (NOT here)|
| which SSE events does the stream emit?              | `src/translator/anthropic_to_openai.rs`       |

## Naming discipline — why this folder is NOT called `fingerprint`

"Fingerprint" is reserved for `src/fingerprint/` — the module whose
bytes the provider could match to ban users who impersonate the
upstream CLI. `harness_corpus/` holds wire artifacts we ship but they
are architecturally distinct from the detection-surface module. See
outer `docs/design/harness-vs-fingerprint.md` for the full split
(RULES.md §1 scope legend pins both zones).

Raw end-to-end captures scrubbed from live sessions (request + response
bodies used as reference for byte-match tests) live at outer
`fingerprint_corpus/` — those are NOT read by code, only by tests and
governance. The code-side `harness_corpus/` here is the derived
artifact set that actually ships inside the binary.

## Refresh procedure

When upstream ships a new Claude Code version and the capture shape
changes:

1. Capture a fresh `/v1/messages` request body per outer
   `docs/capture-protocol.md`.
2. Re-extract the artifacts from the scrubbed body:
   - `body["system"][3]["text"]` → `system-prompt.md`
   - `body["system"][0..3]` → `system-preamble.json` (preserve
     insertion order — use Python `OrderedDict`, NOT `jq -r` which
     adds a trailing newline)
   - Each `<system-reminder>` block from `body["messages"][0]["content"]`
     → a `.txt` / `.tmpl` file under `system-reminders/`
   - Each entry in `body["tools"]` → a separate `.json` under `tools/`
   - Top-level body minus `system` / `messages` / `tools` →
     `envelope.json` (preserve key order)
3. Rerun `cargo test --test harness_artifacts` — 18 byte-match tests
   must stay green or be updated in the same commit.
4. Bump the version reference in `src/harness/mod.rs` module header.

## What this folder does NOT contain

- **Local slash commands** (`/clear`, `/exit`, `/help`, …) — those live
  in `src/tui/slash_catalog.rs` and never cross the wire.
- **Response-shape fixtures** (SSE events, streaming deltas) — those
  are translator concerns under `src/translator/` with fixtures in
  outer `fingerprint_corpus/tools-glob-single/`.
- **Credentials, tokens, user identity** — scrubbed from all captures
  per the protocol. Never commit a file with a live bearer token.
