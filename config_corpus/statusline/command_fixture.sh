#!/bin/sh
# Test fixture for statusline subprocess mode.
# Reads a JSON payload on stdin. If $STATUSLINE_TAP env var is set, appends
# the payload (raw) to that file for round-trip verification. Echoes one
# line to stdout so the dispatcher has something to render.

set -e

PAYLOAD=$(cat)

if [ -n "$STATUSLINE_TAP" ]; then
  printf '%s' "$PAYLOAD" >> "$STATUSLINE_TAP"
fi

echo "fixture ok"
