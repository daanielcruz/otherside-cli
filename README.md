<div align="center">

<img src="images/banner.png" alt="otherside cli" width="720">

![status](https://img.shields.io/badge/status-pre--1.0-EC4899?style=for-the-badge&labelColor=1a1a2e)
![rust](https://img.shields.io/badge/rust-1.83+-51158C?style=for-the-badge&logo=rust&logoColor=white&labelColor=1a1a2e)
![telemetry](https://img.shields.io/badge/telemetry-none-EC4899?style=for-the-badge&labelColor=1a1a2e)
![license](https://img.shields.io/badge/license-MIT-51158C?style=for-the-badge&labelColor=1a1a2e)

### _a shell for the reversed world - where every call is also a return_

[**Install**](#installation) · [**Quick start**](#quick-start) · [**Providers**](#providers) · [**Config**](#configuration) · [**Security**](#security)

</div>

## Overview

Coding CLI inspirated by CC - without telemetry, totally open-source, performance focused, without TRICKS - this keep the best of a harness can do without cheating you - compatible with multiple providers and local llms, it can also serves a local OpenAI-compatible proxy. Otherside put the correct harness in the LLMs but free you to being a company slave and turn you into a opensource hero. The harness goes to the correct place, not at you.

## Quick start

```bash
# 1. install
curl -fsSL https://otherside.sh/install | bash

# 2. log in
otherside login --provider anthropic-oauth

# 3. go
otherside -p "explain this repo in one paragraph"
```

That's it. Drop the `-p` flag and you land in the interactive TUI.

## Installation

**One-liner** — latest release to `~/.local/bin/otherside`:

```bash
curl -fsSL https://otherside.sh/install | bash
```

Re-run to update. Environment overrides:

| Variable                | Purpose                                   |
| ----------------------- | ----------------------------------------- |
| `OTHERSIDE_INSTALL_DIR` | Target directory (default `~/.local/bin`) |
| `OTHERSIDE_VERSION`     | Pin a specific tag instead of latest      |

**From source** — requires stable Rust (MSRV 1.83):

```bash
cargo install --path .
# or
cargo build --release && cp target/release/otherside ~/.local/bin/
```

Ships as a single static-ish binary. `darwin-arm64` today; `linux-x64` in the
oven.

Verify:

```bash
otherside --version
```

## Usage

```bash
# one-shot prompt
otherside -p "explain this repo in one paragraph"

# interactive TUI
otherside tui

# OpenAI-compatible local proxy on :8080
otherside serve --port 8080

# OAuth
otherside login  --provider anthropic-oauth
otherside logout --provider anthropic-oauth
```

It streams responses, pipes in stdin, exits cleanly on `SIGINT`, and writes
to `~/.otherside/` — nowhere else.

## Providers

Four backplates. One wire format on the outside, your choice on the inside.

| Provider            | Auth                              | Status  |
| ------------------- | --------------------------------- | ------- |
| `anthropic-oauth`   | OAuth against Anthropic inference | shipped |
| `codex`             | ChatGPT OAuth + `/v1/responses`   | planned |
| `gemini-cli`        | Google OAuth + Gemini API         | planned |
| `openai-compatible` | Any URL + key combo               | planned |

## Configuration

Four scopes, merged in order (lowest to highest — admin policy always wins):

```
~/.otherside/settings.json          ← user-global
./.otherside/settings.json          ← project-local (walks CWD upward)
--flag                              ← CLI
~/.otherside/managed-settings.json  ← policy (wins last)
~/.otherside/managed-settings.d/*   ← drop-ins, sorted ascending
```

Environment variables do **not** override per-field values. The only env the
config layer reads is `OTHERSIDE_CONFIG_DIR`, which relocates the whole
config home for testing and sandboxing.

Unknown keys round-trip: write a file against a future version, downgrade,
write again — the unknown keys come back untouched.

## Security

- Credentials at `~/.otherside/credentials.json`, mode `0600`, atomic rename
- Keychain on `darwin` when the provider supports it
- Zero analytics, zero error reporting, zero background traffic beyond the
  provider endpoint you chose
- No managed-remote polling, no GrowthBook, no Sentry, no OTLP
- No `Co-Authored-By` trailers in generated commits

If you `strings(1)` the release binary, you will not find your tokens. If you
find a URL that isn't a provider's OAuth or inference endpoint, that is a
bug — file it.

## Status

Pre-1.0. Scaffolded and streaming. The Anthropic provider works end-to-end;
the rest are scheduled. Open work lives in `docs/roadmap.md` in the outer
repo.

`cargo test` is the gate. All-green is the contract.

## Contributing

Issues and PRs welcome. Before opening a PR:

```bash
cargo test -- --test-threads=1
cargo fmt --all
cargo clippy --all-targets -- -D warnings
```

Commits follow conventional style (`feat:`, `fix:`, `refactor:`, `docs:`). No
`Co-Authored-By` trailers in generated commits.

Upstream-facing changes (TUI, slash commands, wire format, tools, auth)
require evidence: a live capture of the reference binary plus a source cite.
Drafting from memory is the repeat failure mode.

## Notes for the curious

<details>
<summary><b>things you'll notice if you poke around</b></summary>

&nbsp;

- The mascot is a black hole — azure and cyan around a deep blue core. Every
  call goes in, something else comes out the other side.
- Every renamed identifier has a paired fingerprint inside the binary
  (`src/internal/`) — a 12-hex-char SHA-256 marker per rename, no plaintext.
  If you're disassembling this for fun, the hashes are the breadcrumb trail.
  They don't decode to anything you don't already have.
- The word _otherside_ is an inversion. The other side of what is left as an
  exercise for the reader.
- Stare at the void long enough and it stares back through a call stack.

</details>

## Star history

<a href="https://www.star-history.com/?repos=daanielcruz%2Fotherside-cli&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=daanielcruz/otherside-cli&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=daanielcruz/otherside-cli&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=daanielcruz/otherside-cli&type=date&legend=top-left" />
 </picture>
</a>

<sub>every cli has two sides. you're looking at one of them.</sub>
