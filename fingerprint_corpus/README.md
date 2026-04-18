# fingerprint_corpus/

Golden HTTP request/response corpus captured from real Claude Code running inside the capture container (`../capture/`). Fuels conformance tests for otherside MVP and beyond.

## What's captured

Every scenario has at minimum:
- `<scenario>/request.json` — full request (method, URL, headers, body)
- `<scenario>/response.json` or `response.sse` — full response (status, headers, body)
- Sensitive fields replaced with placeholders (see Scrubbing below)

Raw Proxyman exports live in `<scenario>/raw/` and are gitignored.

## Session metadata

| Field | Value |
|---|---|
| Claude Code version | 2.1.113 |
| Platform (inside container) | debian:bookworm-slim linux/amd64 |
| Capture date | 2026-04-17 |
| Account tier | Pro/Max (Claude.ai subscription) |
| Account email | `edaanxx@gmail.com` |
| Organization UUID | `361d8f74-6366-4bf0-8184-944d24396350` |
| Account UUID | `4e4b65ad-8f31-475b-a0f8-1e3fafac3c87` |
| Proxy | host Proxyman at `host.docker.internal:9090` |

## Scenarios

### oauth/ — done (2026-04-17)

| Scenario | Flow | Status |
|---|---|---|
| `oauth/hello` | `GET /v1/oauth/hello` | ✅ captured |
| `oauth/login` | `POST /v1/oauth/token` (auth code exchange) | ✅ captured |
| `oauth/refresh` | `POST /v1/oauth/token` (refresh_token exchange) | ✅ captured (forced via past `expiresAt`) |
| `oauth/refresh_behavior.md` | behavioral finding | ✅ — refresh is PROACTIVE (expiresAt check), not reactive on 401 |

### bootstrap/ — done (2026-04-17)

Post-login endpoints called automatically by Claude Code before the first user prompt.

| Scenario | Flow | Status |
|---|---|---|
| `bootstrap/api_hello` | `GET /api/hello` | ✅ captured |
| `bootstrap/profile` | `GET /api/oauth/profile` | ✅ captured |
| `bootstrap/roles` | `GET /api/oauth/claude_cli/roles` | ✅ captured |
| `bootstrap/first_token_date` | `GET /api/organization/claude_code_first_token_date` | ✅ captured |
| `bootstrap/mcp_servers` | `GET /v1/mcp_servers?limit=1000` | ✅ captured |

### inference/ — partial (2026-04-17)

| Scenario | Flow | Status |
|---|---|---|
| `hello` | `POST /v1/messages?beta=true` (prompt="hi") | ✅ captured |
| `hello-thinking` | `POST /v1/messages` with thinking | pending |
| `tool-read` | `POST /v1/messages` with tool_use | pending |
| `rate-limit` | 429 response shape | pending (need to hit limit) |

## Key findings so far (2026-04-17)

### Four distinct user-agent strings (revised 2026-04-17 after full capture)

Claude Code uses FOUR different User-Agent headers depending on which HTTP client library handles the request:

| User-Agent | Endpoints | Implementation |
|---|---|---|
| `claude-cli/2.1.113 (external, cli)` | `/api/hello`, `/v1/oauth/hello` | custom fetch-like HTTP client, canonical CLI UA |
| `claude-cli/2.1.113 (external, sdk-cli)` | `/v1/messages` | Anthropic JS SDK via Stainless fingerprinted headers |
| `axios/1.13.6` | `/v1/oauth/token`, `/api/oauth/profile`, `/api/oauth/claude_cli/roles`, `/v1/mcp_servers` | axios library default UA |
| `claude-code/2.1.113` | `/api/organization/claude_code_first_token_date` | custom short UA (no 'external' marker) |

**Implication for otherside:** need per-endpoint UA strategy. The `/v1/messages` inference path also carries Stainless SDK fingerprint headers (X-Stainless-Arch, Lang, OS, Package-Version, Runtime, Runtime-Version, Timeout, Retry-Count) identifying the Anthropic JS SDK version. These must be mimicked byte-accurately for parity.

### OAuth endpoint host is platform.claude.com (not api.anthropic.com)

| Endpoint | Host |
|---|---|
| OAuth authorize (browser) | `claude.com/cai/oauth/authorize` → 307 → `claude.ai/oauth/authorize` |
| OAuth callback landing | `platform.claude.com/oauth/code/callback` |
| OAuth token exchange | `platform.claude.com/v1/oauth/token` |
| OAuth hello | `platform.claude.com/v1/oauth/hello` |
| Inference | `api.anthropic.com/v1/messages` |

Both hosts must be in Proxyman SSL proxying allowlist for full capture.

### Production OAuth client_id

`9d1c250a-e61b-44d9-88ed-5944d1962f5e` — hardcoded in `../../reconstructed/2.1.113/source/constants/oauth.ts` `CLIENT_ID` field of `PROD_OAUTH_CONFIG`. Env var `CLAUDE_CODE_OAUTH_CLIENT_ID` can override at runtime (useful for IDE integrations).

### Scopes requested (full set)

Claude Code requests ALL scopes on login regardless of actual destination (Console vs Claude.ai) because the server may redirect between flows:

```
org:create_api_key
user:profile
user:inference
user:sessions:claude_code
user:mcp_servers
user:file_upload
```

### OAuth flow shape

Authorization code + PKCE S256. Request body fields in this order:

```json
{
  "grant_type": "authorization_code",
  "code": "<auth_code_from_callback>",
  "redirect_uri": "https://platform.claude.com/oauth/code/callback",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code_verifier": "<pkce_verifier>",
  "state": "<random_state>"
}
```

Response includes `token_type: "bearer"`, `access_token`, `refresh_token`, `expires_in: 28800` (8h), normalized alphabetical `scope`, `token_uuid`, `organization.{uuid,name}`, `account.{uuid,email_address}`.

## Scrubbing

Fields normalized across all committed captures:

| Original | Placeholder |
|---|---|
| Tokens (access/refresh) | `XXX_ACCESS_TOKEN_XXX` / `XXX_REFRESH_TOKEN_XXX` |
| PKCE verifier | `XXX_CODE_VERIFIER_XXX` |
| PKCE challenge | preserved (derivable from verifier) |
| OAuth state | `XXX_STATE_XXX` |
| Auth code | `XXX_AUTH_CODE_XXX` |
| Session IDs | `XXX_SESSION_ID_XXX` |
| Request IDs | `XXX_REQUEST_ID_XXX` |
| CF-RAY headers | `XXX_CF_RAY_XXX` |
| Set-Cookie values | `<redact>` |

Fingerprint-relevant values (UA, client_id, scopes, redirect_uri, header names) are preserved verbatim.
