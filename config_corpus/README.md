# config_corpus

Hand-authored JSON fixtures that define the target shape of the otherside
config layer. Distinct from `fingerprint_corpus/` (which holds captured
upstream traffic used as byte-match anchors). Files here are schema
fixtures — they set the bar for what the loaders in
`otherside-cli/src/config/` must parse, merge, and round-trip.

Edit freely: the purpose is to exercise every documented key, every
precedence rule, every legacy migration, and every validation edge. When
the schema changes, update the fixture *and* the parser in the same
change.

## Layout

```
config_corpus/
├── settings/
│   ├── minimal.json                       — bare-minimum, one key
│   ├── full.json                          — every known key populated
│   ├── with_unknown_keys.json             — known + unknown passthrough
│   ├── with_permission_rules.json         — allow/deny tree
│   ├── with_hooks.json                    — pre/post tool hooks
│   ├── invalid_permission_rule.json       — one good + one malformed rule
│   ├── malformed.json                     — syntactically broken JSON
│   └── yolo_mode.json                     — canonical yolo permission mode
├── projects/
│   ├── empty.json
│   └── with_trust.json
├── mcp/
│   ├── stdio.json
│   ├── sse_http_mix.json
│   └── project_parent_walk/
│       └── root/
│           ├── .mcp.json                  — parent set
│           └── sub/
│               └── .mcp.json              — child-wins set
└── managed/
    ├── base.json                          — single policy file
    └── base_plus_dropins/
        ├── managed-settings.json
        └── managed-settings.d/
            ├── 00-org.json                — earlier drop-in
            └── 10-team.json               — later drop-in, wins on conflict
```

## Conventions

- Top-level field names are camelCase (`permissionMode`, `hasAcceptedYoloDialog`).
- String values use exact canonical spellings (`"yolo"` not `"YOLO"`, provider IDs lowercase with hyphens).
- Paths that may migrate (legacy values) live in `legacy_*.json` fixtures and exercise the migrate-on-read deserializers.
- `malformed.json` is the only file that MUST fail to parse. Every other file MUST parse, even when semantically invalid at a deeper level (invalid rules are dropped with a warning, not a hard fail).
