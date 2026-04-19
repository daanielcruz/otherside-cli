<div align="center">

<img src="images/black-hole.png" alt="the mascot, a black hole" width="200">

_the cli from the other side of the stack frame_
_a shell for the reversed world — where every call is also a return_

</div>

---

## what this is

A terminal-native interactive coding agent, written in Rust. You give it a
prompt or a repo and it plans, reads, edits, runs shells. It speaks OpenAI on
the outside and whichever provider you bring on the inside.

Four providers on the backplate:

- `anthropic-oauth` — OAuth login against Anthropic's inference API (shipped)
- `codex` — ChatGPT OAuth + the `/v1/responses` surface (planned)
- `gemini-cli` — Google OAuth + the Gemini API (planned)
- `openai-compatible` — any URL + key combo you've got (planned)

The binary stays a single file. No auto-updater. No telemetry. No remote
configuration surface pushing things onto your shell while you sleep.

## install

```bash
cargo install --path .
# or
cargo build --release && cp target/release/otherside ~/.local/bin/
```

Requires stable Rust (MSRV 1.83). Ships as a single static-ish binary on
darwin-arm64 today; Linux-x64 in the oven.

## use

```bash
# one-shot
otherside -p "explain this repo in one paragraph"

# interactive
otherside tui

# OpenAI-compatible local proxy on :8080
otherside serve --port 8080

# OAuth
otherside login  --provider anthropic-oauth
otherside logout --provider anthropic-oauth
```

Pipe anything in. It streams responses. It exits on SIGINT. It writes to
`~/.otherside/` and nowhere else.

## config

Four scopes, merged in this order (lowest to highest, admin policy always wins):

```
~/.otherside/settings.json          ← user-global
./.otherside/settings.json          ← project-local (walks CWD upward)
--flag                              ← CLI
~/.otherside/managed-settings.json  ← policy (wins last)
~/.otherside/managed-settings.d/*   ← drop-ins, sorted ascending
```

Environment variables **do not** override per-field values. The only env the
config layer reads is `OTHERSIDE_CONFIG_DIR`, which relocates the whole
config home for testing and sandboxing.

Unknown keys round-trip. Write a file against a future version, downgrade,
write again — the unknown keys come back.

## opsec

- Credentials at `~/.otherside/credentials.json`, mode `0600`, atomic rename
- Keychain on darwin when the provider supports it
- Zero analytics, zero error-reporting, zero background traffic beyond the
  provider endpoint you chose
- No managed-remote polling, no GrowthBook, no Sentry, no OTLP
- No `Co-Authored-By` lines in generated commits

If you `strings(1)` the release binary, you will not find your tokens. If you
find a URL that isn't a provider's OAuth or inference endpoint, that is a
bug — file it.

## status

Pre-1.0. Scaffolded and streaming. The Anthropic provider works end-to-end;
the rest are scheduled. The agent loop (tools, permissions, hooks, sessions)
is landing in phases — see `openspec/changes/` for what's in flight.

Tests: `cargo test` is the gate. Floor 413 as of 2026-04-18. Count drifts with feature work — all-green is the contract per RULES.md R-112.

## notes for the curious

<details>
<summary>things you'll notice if you poke around</summary>

- The mascot is a Rubik's cube with the centerpiece pulled. The voids you see
  are where the state would normally hide — exposure is the point.
- `#51158C` and `#EC4899` are the house colors. Violet for signal, pink for
  attention. If you have `truecolor` disabled, the TUI falls back gracefully.
- Every renamed identifier has a paired fingerprint inside the binary
  (`otherside-cli/src/internal/`) — a 12-hex-char SHA-256 marker per rename,
  no plaintext. If you're disassembling this for fun, the hashes are the
  breadcrumb trail. They don't decode to anything you don't already have.
- The word "otherside" is an inversion. The other side of what is left as an
  exercise for the reader.
- If you stare at the cube long enough, it stares back through a call stack.

</details>

## license

Not yet decided. This repo is private until it's not.

---

<sub>`Rev. — ` every cli has two sides. you're looking at one of them.</sub>
