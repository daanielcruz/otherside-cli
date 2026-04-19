# fingerprint-stamp — R-42 rename marker

Compute the 12-hex-char SHA256 fingerprint of an upstream fully-qualified identifier, per `RULES.md` R-42. Used when registering a new upstream→otherside rename in `otherside-cli/src/internal/rename_map.rs` (R-41 active).

## Input

One positional argument: `upstream_fqn` — the upstream identifier string as it appears in `reconstructed/2.1.113/source/`. Convention: strip `.ts` / `.tsx` extension from the path component; preserve `::` between path and symbol.

Examples:

- `utils/sendMessage`
- `services/api/claude::sendMessage`
- `hooks/toolPermission::checkPermission`

## Algorithm

```
hash = SHA256(upstream_fqn)[0..12]   # 12 hex chars = 6 bytes = 48 bits
```

Bash (use `printf '%s'`, never `echo` — the trailing newline changes the hash):

```bash
printf '%s' "$1" | shasum -a 256 | cut -c1-12
```

## Output

Echo the 12-char hex hash. Nothing else.

```
$ bash SKILL.md 'utils/sendMessage'
46eb7149ef13
```

## Collision check (optional, caller-driven)

At 48 bits the collision probability across a ~10k identifier surface is astronomically small, but the check is cheap:

```bash
HASH=$(printf '%s' "$1" | shasum -a 256 | cut -c1-12)
grep -R "$HASH" /Users/danielcruz/Desktop/otherside/otherside-cli/src/internal/rename_map.rs \
  /Users/danielcruz/Desktop/otherside/MAPPING.md 2>/dev/null
```

A hit against the SAME `upstream_fqn` is benign (already stamped). A hit against a DIFFERENT upstream identifier is a collision — extend the hash length or pick a different normalization, then re-stamp.

## Apply checklist (caller runs manually — skill is read-only)

1. Add the row to `MAPPING.md` with `rf:<hash>` in the Notes column.
2. Add `("<hash>", "<otherside_id>"),` to `otherside-cli/src/internal/rename_map.rs`.
3. `cd otherside-cli && cargo test` — the rename-map completeness test must pass (R-112).
4. Commit per R-113 (small, reviewable, MAPPING row + rename_map entry + code change in the same commit).

## Hard rules

- READ-ONLY. The skill ONLY computes and echoes the hash. Never edits `MAPPING.md`, `rename_map.rs`, or source files.
- Use `printf '%s'` — `echo` appends `\n` and yields a different digest.
- 12 hex chars canonical per R-42 (resolved 2026-04-17). Do not truncate to fewer; do not extend without updating R-42.
