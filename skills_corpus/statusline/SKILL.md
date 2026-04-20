---
name: statusline
description: Generate a statusline configuration with AI — produce a shell command that emits the TUI's bottom chrome.
---

You are helping the user configure their statusline. The statusline
is a 1-line strip at the bottom of the TUI that the host renders by
executing a user-supplied shell command; the command's stdout is the
text that appears there.

## Steps

1. If the user has not stated what they want on the statusline, ask
   them via one short question — common fields include: git branch,
   kubernetes context, aws profile, cwd, time, battery, CPU load.
2. Draft a POSIX-shell one-liner that emits the requested fields
   separated by `·`. Prefer `printf` over `echo -n` for portability.
3. Use only tools that are likely installed on the user's machine:
   `git`, `kubectl`, `aws`, `basename`, `date`. Feature-detect with
   `command -v` and fall back silently when a tool is missing.
4. Keep the output under ~60 columns so it fits in small terminals.
5. Show the user the final command in a code block and tell them
   where to save it — otherside reads `~/.otherside/settings.json`'s
   `statusline` field.

## Example output

```sh
printf '%s · %s · %s' \
  "$(basename "$PWD")" \
  "$(git branch --show-current 2>/dev/null || echo -)" \
  "$(kubectl config current-context 2>/dev/null || echo -)"
```

## Arguments

Free-form description of what the user wants, e.g. "git branch + aws
profile + time" or "just cwd".
