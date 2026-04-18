# statusline corpus

Hand-authored fixtures for the statusline render + subprocess pipeline.
Same disclaimer as the parent `config_corpus/README.md`: these are
schema fixtures, not captured traffic.

## Contents

```
statusline/
├── input_fresh_session.json          — minimal payload: fresh session, zero cost, zero context
├── input_mid_conversation.json       — populated cost + context_window + added_dirs
├── input_over_200k.json              — `exceeds_200k_tokens: true`, usage over limit
├── input_yolo_active.json            — structurally identical to mid_conversation (C48:
│                                       payload never carries permission state; yolo chip lives
│                                       only in the native renderer ctx, never in user-script land)
├── expected_native_fresh.txt         — byte-exact native render at width 80 for fresh session
├── expected_native_over_200k.txt     — byte-exact native render at width 80 for the 200k case
└── command_fixture.sh                — test fixture: reads stdin JSON, echoes one line
```

## Payload shape

Top-level fields match the upstream `StatusLineCommandInput` shape verbatim
(harness fidelity — user `jq` pipelines parse these names). Field order
follows the upstream struct declaration, preserved through `serde_json`
with the `preserve_order` feature (per C49).

Required primary fields:

- `session_id` — UUID v4
- `transcript_path` — absolute path to the session's JSONL transcript
- `cwd` — absolute current working directory
- `model { id, display_name }`
- `workspace { current_dir, project_dir, added_dirs: [abs paths] }`
- `version` — otherside semver string
- `output_style { name }`
- `cost { total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed }`
- `context_window { total_input_tokens, total_output_tokens, context_window_size, current_usage, used_percentage, remaining_percentage }`
- `exceeds_200k_tokens: bool`

Optional fields (only emitted when the underlying state is non-empty):

- `session_name`
- `rate_limits { five_hour?, seven_day? }`
- `vim { mode }`
- `agent { name }`
- `remote { session_id }`
- `worktree { name, path, branch, original_cwd, original_branch }`

## Explicitly NOT in the payload

Per C48, the payload does NOT carry any permission-mode indicator. User
scripts cannot observe yolo state through the statusline JSON. The
native renderer reads permission mode from internal `StatuslineCtx`
instead, never leaking it across the user-script boundary.
